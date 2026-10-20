// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { iaPlanReviewerPolicyDigest } from "../src/ia/index.js";
import type {
  SiteBootstrapRunRecord,
  SiteBootstrapRunStore,
} from "../src/site-bootstrap/contracts.js";
import {
  prepareSiteBootstrapApprovalGrant,
  SiteBootstrapRunner,
  SiteBootstrapRunnerError,
  type SiteBootstrapApprovalGrant,
} from "../src/site-bootstrap/index.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryCheckCapability } from "../src/templates/checks.js";
import type { TemplateSetCapability } from "../src/templates/load.js";
import type { TemplateScaffoldSummary } from "../src/templates/scaffold.js";
import {
  CATALOG_POLICY,
  CHECK_POLICY,
  SITE_BOOTSTRAP_REVIEWER_POLICY,
  siteBootstrapAfterIndex,
  siteBootstrapBundle,
  siteBootstrapIndex,
} from "./site-bootstrap-fixtures.js";
import { fixtureRepository } from "./site-bootstrap-test-repository.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const NOW = new Date("2026-08-03T20:00:00.000Z");

class Store implements SiteBootstrapRunStore {
  records: SiteBootstrapRunRecord[] = [];
  async save(record: SiteBootstrapRunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic site bootstrap runner", () => {
  it("defers impact and patch finalization to one authoritative outer caller", async () => {
    const fixture = await fixtureRepository(roots);
    const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    const index = siteBootstrapIndex(workspace.revision);
    const bundle = siteBootstrapBundle(index, NOW);
    const store = new Store();
    let evidenceCalls = 0;
    let postflightCalls = 0;
    const runner = new SiteBootstrapRunner({
      store,
      repositoryEvidence: {
        capture: async () => {
          evidenceCalls += 1;
          return { files: [] };
        },
      },
      reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      now: () => NOW,
      currentIndex: { build: async () => index },
      postflightIndex: {
        build: async () => {
          postflightCalls += 1;
          return siteBootstrapAfterIndex(index);
        },
      },
      scaffold: async () => summary(bundle.plan.digest),
      postMutationFinalization: "caller",
    });
    try {
      const record = await runner.run(runInput(workspace, fixture.path, bundle));
      expect(record).toMatchObject({ status: "succeeded", mutationBoundaryEntered: true });
      expect(record.changes).toBeUndefined();
      expect(record.impactPostflight).toBeUndefined();
      expect(evidenceCalls).toBe(0);
      expect(postflightCalls).toBe(0);
      expect(store.records.at(-1)?.status).toBe("succeeded");
    } finally {
      await workspace.dispose();
    }
  });

  it("captures an exact clean patch and terminal record while source stays unchanged", async () => {
    const fixture = await fixtureRepository(roots);
    const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    const artifactRoot = await mkdtemp(join(tmpdir(), "docsfab-site-bootstrap-patches-"));
    roots.push(artifactRoot);
    const collector = await GitPatchEvidenceCollector.create(workspace.path, artifactRoot);
    try {
      const index = siteBootstrapIndex(workspace.revision);
      const bundle = siteBootstrapBundle(index, NOW);
      const store = new Store();
      const runner = new SiteBootstrapRunner({
        store,
        repositoryEvidence: collector,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
        now: () => NOW,
        id: () => "site-bootstrap-success",
        currentIndex: { build: async () => index },
        postflightIndex: { build: async () => siteBootstrapAfterIndex(index) },
        scaffold: async () => {
          const output = join(workspace.path, "docs/get-started/quickstart.md");
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, "# Quickstart\n", "utf8");
          return summary(bundle.plan.digest);
        },
      });
      const record = await runner.run(runInput(workspace, fixture.path, bundle));

      expect(record).toMatchObject({ status: "succeeded", mutationBoundaryEntered: true });
      expect(record.impactPostflight).toMatchObject({
        status: "completed",
        beforeRepository: { revision: workspace.revision },
        afterRepository: { revision: workspace.revision },
        changedPaths: ["docs/get-started/quickstart.md"],
      });
      expect(record.changes?.files).toEqual([
        { path: "docs/get-started/quickstart.md", status: "added" },
      ]);
      expect(store.records.at(-1)?.status).toBe("succeeded");
      expect(await gitStatus(fixture.path)).toBe("");
      expect(await readFile(record.changes!.patch!.artifactPath, "utf8")).toContain(
        "+++ b/docs/get-started/quickstart.md",
      );
      await execFileAsync("git", [
        "-C",
        fixture.path,
        "apply",
        "--check",
        record.changes!.patch!.artifactPath,
      ]);
    } finally {
      await collector.dispose();
      await workspace.dispose();
    }
  });

  it("preserves patch and failed terminal record for an injected post-mutation interruption", async () => {
    const fixture = await fixtureRepository(roots);
    const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    const artifactRoot = await mkdtemp(join(tmpdir(), "docsfab-site-bootstrap-interrupt-"));
    roots.push(artifactRoot);
    const collector = await GitPatchEvidenceCollector.create(workspace.path, artifactRoot);
    try {
      const index = siteBootstrapIndex(workspace.revision);
      const bundle = siteBootstrapBundle(index, NOW);
      const store = new Store();
      const runner = new SiteBootstrapRunner({
        store,
        repositoryEvidence: collector,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
        now: () => NOW,
        id: () => "site-bootstrap-interrupted",
        currentIndex: { build: async () => index },
        postflightIndex: { build: async () => siteBootstrapAfterIndex(index) },
        scaffold: async () => {
          const output = join(workspace.path, "docs/get-started/quickstart.md");
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, "# Quickstart\n", "utf8");
          return summary(bundle.plan.digest);
        },
        afterScaffold: () => {
          throw new SiteBootstrapRunnerError("interrupted");
        },
      });
      const record = await runner.run(runInput(workspace, fixture.path, bundle));

      expect(record).toMatchObject({ status: "failed", error: "interrupted" });
      expect(record.impactPostflight).toMatchObject({
        status: "completed",
        changedPaths: ["docs/get-started/quickstart.md"],
      });
      expect(record.changes?.patch).toBeDefined();
      expect(store.records.at(-1)?.status).toBe("failed");
      expect(await gitStatus(fixture.path)).toBe("");
    } finally {
      await collector.dispose();
      await workspace.dispose();
    }
  });

  it("fails closed before mutation without write, authentic approval, matching policy, or current index", async () => {
    const fixture = await fixtureRepository(roots);
    const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    const index = siteBootstrapIndex(workspace.revision);
    const bundle = siteBootstrapBundle(index, NOW);
    const evidence = {
      calls: 0,
      async capture() {
        this.calls += 1;
        return { files: [] };
      },
    };
    let scaffoldCalls = 0;
    const makeRunner = (current = index) =>
      new SiteBootstrapRunner({
        store: new Store(),
        repositoryEvidence: evidence,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
        now: () => NOW,
        currentIndex: { build: async () => current },
        postflightIndex: { build: async () => siteBootstrapAfterIndex(current) },
        scaffold: async () => {
          scaffoldCalls += 1;
          return summary(bundle.plan.digest);
        },
      });
    const valid = runInput(workspace, fixture.path, bundle);
    try {
      await expect(makeRunner().run({ ...valid, allowWrite: false })).resolves.toMatchObject({
        status: "failed",
        error: "write-not-authorized",
      });
      await expect(
        makeRunner().run({
          ...valid,
          approval: {} as SiteBootstrapApprovalGrant,
        }),
      ).resolves.toMatchObject({ status: "failed", error: "invalid-approval" });
      await expect(
        makeRunner().run({
          ...valid,
          templates: { ...valid.templates, catalogDigest: "f".repeat(64) },
        }),
      ).resolves.toMatchObject({ status: "failed", error: "policy-mismatch" });
      await expect(
        makeRunner({
          ...index,
          indexDigest: "f".repeat(64),
        }).run(valid),
      ).resolves.toMatchObject({ status: "failed", error: "stale-repository" });
      expect(scaffoldCalls).toBe(0);
      expect(evidence.calls).toBe(0);
      expect(await gitStatus(fixture.path)).toBe("");
    } finally {
      await workspace.dispose();
    }
  });

  it("does not let a self-consistent attacker policy authorize application", async () => {
    const fixture = await fixtureRepository(roots);
    const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    const index = siteBootstrapIndex(workspace.revision);
    const attackerKeys = generateKeyPairSync("ed25519");
    const attackerValue = {
      id: "attacker:site-bootstrap-reviewers",
      version: "1",
      reviewers: [
        {
          id: "maintainer:docs",
          role: "maintainer" as const,
          publicKey: attackerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ],
    };
    const attackerPolicy = {
      ...attackerValue,
      digest: iaPlanReviewerPolicyDigest(attackerValue),
    };
    const attackerBundle = siteBootstrapBundle(index, NOW, {
      policy: attackerPolicy,
      reviewerId: "maintainer:docs",
      privateKey: attackerKeys.privateKey,
    });
    const attackerGrant = prepareSiteBootstrapApprovalGrant({
      bundle: attackerBundle,
      reviewerPolicy: attackerPolicy,
      evaluationTime: NOW,
    });
    let scaffoldCalls = 0;
    const runner = new SiteBootstrapRunner({
      store: new Store(),
      repositoryEvidence: { capture: async () => ({ files: [] }) },
      reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      currentIndex: { build: async () => index },
      scaffold: async () => {
        scaffoldCalls += 1;
        return summary(attackerBundle.plan.digest);
      },
      now: () => NOW,
    });
    try {
      const valid = runInput(workspace, fixture.path, siteBootstrapBundle(index, NOW));
      await expect(
        runner.run({
          ...valid,
          bundle: attackerBundle,
          approval: attackerGrant,
        }),
      ).rejects.toEqual(new SiteBootstrapRunnerError("invalid-bundle"));
      expect(scaffoldCalls).toBe(0);
      expect(await gitStatus(fixture.path)).toBe("");
    } finally {
      await workspace.dispose();
    }
  });

  it("records a failed terminal result when mutation escapes the approved create scope", async () => {
    const fixture = await fixtureRepository(roots);
    const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    const artifactRoot = await mkdtemp(join(tmpdir(), "docsfab-site-bootstrap-scope-"));
    roots.push(artifactRoot);
    const collector = await GitPatchEvidenceCollector.create(workspace.path, artifactRoot);
    try {
      const index = siteBootstrapIndex(workspace.revision);
      const bundle = siteBootstrapBundle(index, NOW);
      const store = new Store();
      const runner = new SiteBootstrapRunner({
        store,
        repositoryEvidence: collector,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
        now: () => NOW,
        currentIndex: { build: async () => index },
        postflightIndex: { build: async () => siteBootstrapAfterIndex(index) },
        id: () => "site-bootstrap-out-of-scope",
        scaffold: async () => {
          const approved = join(workspace.path, "docs/get-started/quickstart.md");
          await mkdir(dirname(approved), { recursive: true });
          await writeFile(approved, "# Quickstart\n", "utf8");
          await writeFile(join(workspace.path, "unexpected.md"), "unexpected\n", "utf8");
          return summary(bundle.plan.digest);
        },
      });
      const record = await runner.run(runInput(workspace, fixture.path, bundle));
      expect(record).toMatchObject({ status: "failed", error: "unexpected-changes" });
      expect(record.changes?.patch).toBeDefined();
      expect(store.records.at(-1)?.status).toBe("failed");
      expect(await gitStatus(fixture.path)).toBe("");
    } finally {
      await collector.dispose();
      await workspace.dispose();
    }
  });

  it("preserves the patch and terminal record when impact postflight fails after mutation", async () => {
    const fixture = await fixtureRepository(roots);
    const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    const artifactRoot = await mkdtemp(join(tmpdir(), "docsfab-site-bootstrap-impact-failure-"));
    roots.push(artifactRoot);
    const collector = await GitPatchEvidenceCollector.create(workspace.path, artifactRoot);
    try {
      const index = siteBootstrapIndex(workspace.revision);
      const bundle = siteBootstrapBundle(index, NOW);
      const store = new Store();
      const runner = new SiteBootstrapRunner({
        store,
        repositoryEvidence: collector,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
        now: () => NOW,
        currentIndex: { build: async () => index },
        postflightIndex: {
          build: async () => {
            throw new Error("injected postflight failure");
          },
        },
        id: () => "site-bootstrap-impact-failure",
        scaffold: async () => {
          const output = join(workspace.path, "docs/get-started/quickstart.md");
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, "# Quickstart\n", "utf8");
          return summary(bundle.plan.digest);
        },
      });
      const record = await runner.run(runInput(workspace, fixture.path, bundle));

      expect(record).toMatchObject({
        status: "failed",
        error: "impact-postflight-failed",
        impactPostflight: { status: "failed", reason: "analysis-failed" },
        changes: { patch: { format: "git-diff" } },
      });
      expect(store.records.at(-1)?.status).toBe("failed");
      expect(await gitStatus(fixture.path)).toBe("");
    } finally {
      await collector.dispose();
      await workspace.dispose();
    }
  });
});

function runInput(
  workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>>,
  sourcePath: string,
  bundle: ReturnType<typeof siteBootstrapBundle>,
) {
  return {
    allowWrite: true,
    workspace,
    repository: {
      sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    bundle,
    approval: prepareSiteBootstrapApprovalGrant({
      bundle,
      reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      evaluationTime: NOW,
    }),
    templates: {
      catalogDigest: CATALOG_POLICY.digest,
      bundle: {},
    } as TemplateSetCapability,
    checks: {
      id: CHECK_POLICY.id,
      version: CHECK_POLICY.version,
      digest: CHECK_POLICY.digest,
    } as RepositoryCheckCapability,
  };
}

function summary(planDigest: string): TemplateScaffoldSummary {
  return {
    schemaVersion: 1,
    operation: "site",
    repository: { revision: "a".repeat(40), contentDigest: "b".repeat(64) },
    planDigest,
    previewDigest: "1".repeat(64),
    catalogDigest: CATALOG_POLICY.digest,
    outputs: [],
    validations: [],
    transaction: { schemaVersion: 1, planDigest: "2".repeat(64), outputs: [], totalByteLength: 0 },
    repositoryChecks: {
      schemaVersion: 1,
      policy: CHECK_POLICY,
      status: "passed",
      results: [],
      digest: "3".repeat(64),
    },
    digest: "4".repeat(64),
  };
}

async function gitStatus(path: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", path, "status", "--porcelain"], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}
