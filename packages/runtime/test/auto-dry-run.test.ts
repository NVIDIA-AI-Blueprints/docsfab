// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAutoDryRunCliArguments, runAutoDryRunCli } from "../src/autonomy/dry-run-cli.js";
import { DOCUMENTATION_MATURITY_HOST_POLICY_PATH } from "../src/maturity/evaluators.js";
import {
  createAutoDryRunNeedsInput,
  createAutoDryRun,
  decodeAutoDryRunResult,
  formatAutoDryRun,
  serializeAutoDryRun,
  type AutoDryRunNeedsInputV1,
} from "../src/autonomy/dry-run.js";
import {
  autoDryRunHostWorkspace,
  assessAutoDryRunHostWithDependencies,
  productionAutoDryRunRoadmapPlanner,
  type AutoDryRunHostReadDependencies,
} from "../src/autonomy/dry-run-host.js";
import { PROJECT_CONFIG_UNTRACKED_CODE } from "../src/project-config-preflight.js";
import { canonicalDigest, canonicalJson } from "../src/content-ir/canonical.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  createManagedIssueStateLookupV1,
  renderManagedIssueMarker,
  roadmapDigest,
} from "../src/roadmap/index.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporary = temporaryRoots();

describe("auto dry-run product shell", () => {
  it("parses only the exact read-only command form", () => {
    expect(parseAutoDryRunCliArguments(["--dry-run"], "/repo")).toEqual({
      mode: "dry-run",
      repositoryPath: "/repo",
      revision: "HEAD",
      json: false,
    });
    expect(
      parseAutoDryRunCliArguments(
        [
          "--dry-run",
          "--repo",
          "fixture",
          "--revision",
          "main",
          "--target-branch",
          "main",
          "--json",
        ],
        "/repo",
      ),
    ).toEqual({
      mode: "dry-run",
      repositoryPath: "/repo/fixture",
      revision: "main",
      targetBranch: "main",
      json: true,
    });
    expect(() => parseAutoDryRunCliArguments(["--once"])).toThrow("exactly --dry-run");
    expect(() => parseAutoDryRunCliArguments(["--dry-run", "--apply"])).toThrow("Unknown");
    expect(() =>
      parseAutoDryRunCliArguments(["--dry-run", "--repo", "one", "--repo", "two"]),
    ).toThrow("Duplicated");
    expect(() =>
      parseAutoDryRunCliArguments(["--dry-run", "--target-branch", "bad branch"]),
    ).toThrow("invalid");
  });

  it("returns stable useful needs-input evidence without changing the source checkout", async () => {
    const fixture = await repositoryFixture();
    const before = await gitStatus(fixture);
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    const inventory = await buildRepositoryDiscoveryInventory({ workspace });
    const input: AutoDryRunNeedsInputV1 = {
      repositoryPath: workspace.sourcePath,
      repository: {
        identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
        revision: workspace.revision,
      },
      inventory,
      reasonCode: "documentation-product-policy-required",
      openInputIds: ["documentation-product-policy"],
      targetBranch: "main",
      draftMergeRequestDestination: null,
    };
    const first = createAutoDryRunNeedsInput(input);
    const second = createAutoDryRunNeedsInput(input);
    await workspace.dispose();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      readOnly: true,
      authorization: null,
      decision: {
        disposition: "needs-input",
        reasonCode: "documentation-product-policy-required",
        openInputIds: ["documentation-product-policy"],
      },
      operations: [],
    });
    expect(first.resultSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.nextAction).toBe(
      `docsfab auto --once --repo ${workspace.sourcePath} --revision ${workspace.revision} --target-branch main`,
    );
    expect(formatAutoDryRun(first).endsWith(`Next: ${first.nextAction}`)).toBe(true);
    expect(formatAutoDryRun(first)).toContain("Open inputs: documentation-product-policy");
    expect(JSON.parse(serializeAutoDryRun(first))).toEqual(first);
    expect(decodeAutoDryRunResult(structuredClone(first))).toEqual(first);

    const expanded = structuredClone(first) as unknown as Record<string, unknown>;
    (expanded.decision as Record<string, unknown>).unexpected = "caller-authored";
    const { resultSha256: _resultSha256, ...expandedBody } = expanded;
    expanded.resultSha256 = canonicalDigest(expandedBody);
    expect(() => decodeAutoDryRunResult(expanded)).toThrow("invalid-source");

    const changedNext = structuredClone(first);
    changedNext.nextAction = "docsfab auto --once --repo /different";
    expect(() => decodeAutoDryRunResult(rehashResult(changedNext))).toThrow("invalid-source");
    const danglingEvidence = structuredClone(first);
    danglingEvidence.decision.evidenceIds = ["missing-evidence"];
    expect(() => decodeAutoDryRunResult(rehashResult(danglingEvidence))).toThrow("invalid-source");
    const mismatchedConfidence = structuredClone(first);
    mismatchedConfidence.decision.confidence = "high";
    expect(() => decodeAutoDryRunResult(rehashResult(mismatchedConfidence))).toThrow(
      "invalid-source",
    );
    const mismatchedPathIdentity = structuredClone(first);
    mismatchedPathIdentity.repository.path = "/different/repository";
    expect(() => decodeAutoDryRunResult(rehashResult(mismatchedPathIdentity))).toThrow(
      "invalid-source",
    );
    const mismatchedInventoryEvidence = structuredClone(first);
    mismatchedInventoryEvidence.evidence[0]!.sha256 = "d".repeat(64);
    expect(() => decodeAutoDryRunResult(rehashResult(mismatchedInventoryEvidence))).toThrow(
      "invalid-source",
    );
    expect(() =>
      createAutoDryRunNeedsInput({
        ...input,
        draftMergeRequestDestination: {
          provider: "gitlab",
          projectIdentitySha256: "not-a-digest",
          targetBranch: "main",
        },
      }),
    ).toThrow("invalid-source");
    expect(() =>
      createAutoDryRunNeedsInput({
        ...input,
        repositoryPath: "/different/repository",
      }),
    ).toThrow("invalid-source");
    const destinationBound = createAutoDryRunNeedsInput({
      ...input,
      draftMergeRequestDestination: {
        provider: "gitlab",
        projectIdentitySha256: "c".repeat(64),
        targetBranch: "main",
      },
    });
    const changedDestination = structuredClone(destinationBound);
    changedDestination.draftMergeRequestDestination!.targetBranch = "other";
    expect(() => decodeAutoDryRunResult(rehashResult(changedDestination))).toThrow(
      "invalid-source",
    );
    expect(await gitStatus(fixture)).toBe(before);
  });

  it("keeps JSON output clean and always disposes the host observation", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture, "HEAD");
    const inventory = await buildRepositoryDiscoveryInventory({ workspace });
    await workspace.dispose();
    const output: string[] = [];
    const progress: string[] = [];
    let disposed = 0;
    const result = await runAutoDryRunCli(["--dry-run", "--json"], {
      assess: async () => ({
        status: "needs-input",
        input: {
          repositoryPath: fixture,
          repository: {
            identitySha256: createHash("sha256").update(fixture).digest("hex"),
            revision: inventory.repositoryRevision,
          },
          inventory,
          reasonCode: "default-target-unavailable",
          openInputIds: ["gitlab-default-target"],
          targetBranch: null,
          draftMergeRequestDestination: null,
        },
        dispose: async () => {
          disposed += 1;
        },
      }),
      log: (message) => output.push(message),
      progress: (phase) => progress.push(phase),
    });
    expect(disposed).toBe(1);
    expect(progress).toEqual(["inspect", "assess", "complete"]);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual(result);
    expect(output[0]).not.toContain("undefined");
  });

  it("routes an authentic host snapshot through the exact #106 seam without mutating source", async () => {
    const fixture = await repositoryFixture(true);
    const before = await gitStatus(fixture);
    const calls: Array<{ url: string; method: string; token: string | null }> = [];
    let revision = "";
    const host = await assessAutoDryRunHostWithDependencies(
      {
        mode: "dry-run",
        repositoryPath: fixture,
        revision: "HEAD",
        json: true,
      },
      {
        trustedGitLabHost: () => "gitlab.example.com",
        tokenForHost: async (requestedHost) => {
          expect(requestedHost).toBe("gitlab.example.com");
          return "host-specific-token";
        },
        fetch: async (input, init) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          calls.push({
            url,
            method: init?.method ?? "GET",
            token: headers.get("private-token"),
          });
          if (url.endsWith("/api/v4/projects/group%2Fproject"))
            return jsonResponse({
              id: 42,
              path_with_namespace: "group/project",
              default_branch: "main",
            });
          if (url.includes("/repository/commits/")) {
            revision = decodeURIComponent(url.split("/").at(-1)!);
            return jsonResponse({ id: revision });
          }
          if (url.includes("/issues?")) return jsonResponse([]);
          throw new Error(`Unexpected fetch ${url}`);
        },
        managedStateLookup: () => ({
          authority: "restored-receipt-evidence",
          lookup: createManagedIssueStateLookupV1([]),
        }),
      },
    );
    try {
      expect(host.status).toBe("ready");
      if (host.status !== "ready") throw new Error("expected ready host assessment");
      const first = await createAutoDryRun(host.source, productionAutoDryRunRoadmapPlanner);
      const second = await createAutoDryRun(host.source, productionAutoDryRunRoadmapPlanner);
      expect(second).toEqual(first);
      expect(first.repository.revision).toBe(revision);
      expect(first.decision.disposition).toBe("execute");
      expect(first.decision.workflow).not.toBeNull();
      expect(first.operations.some((item) => item.target.kind === "issue")).toBe(true);
      if (host.source.request.bounds.deliveryMode === "none") {
        expect(first.draftMergeRequestDestination).toBeNull();
        expect(first.operations.some((item) => item.action === "draft-mr")).toBe(false);
      }
      expect(
        first.operations.every(
          (item) => item.performsMutation === false && item.evidenceIds.length > 0,
        ),
      ).toBe(true);
      expect(decodeAutoDryRunResult(structuredClone(first))).toEqual(first);
      const pathSubstitution = structuredClone(host.source);
      pathSubstitution.repositoryPath = "/different/repository";
      await expect(
        createAutoDryRun(pathSubstitution, productionAutoDryRunRoadmapPlanner),
      ).rejects.toThrow("binding-mismatch");
      const targetSubstitution = structuredClone(host.source);
      targetSubstitution.targetBranch = "other";
      targetSubstitution.draftMergeRequestDestination.targetBranch = "other";
      await expect(
        createAutoDryRun(targetSubstitution, productionAutoDryRunRoadmapPlanner),
      ).rejects.toThrow("binding-mismatch");
      const projectSubstitution = structuredClone(host.source);
      projectSubstitution.draftMergeRequestDestination.projectIdentitySha256 = "e".repeat(64);
      await expect(
        createAutoDryRun(projectSubstitution, productionAutoDryRunRoadmapPlanner),
      ).rejects.toThrow("binding-mismatch");
      await expect(
        createAutoDryRun(host.source, {
          plan: async (source) => {
            const projection = structuredClone(
              await productionAutoDryRunRoadmapPlanner.plan(source),
            );
            projection.source.requestSha256 = "f".repeat(64);
            projection.digest = roadmapDigest(projection);
            return projection;
          },
        }),
      ).rejects.toThrow("invalid-roadmap-preview");
      for (const mutate of [
        (projection: Awaited<ReturnType<typeof productionAutoDryRunRoadmapPlanner.plan>>) => {
          projection.planning.rankedProposals.pop();
          projection.planning.digest = roadmapDigest(projection.planning);
        },
        (projection: Awaited<ReturnType<typeof productionAutoDryRunRoadmapPlanner.plan>>) => {
          const reconciliation = projection.reconciliations[0]!;
          reconciliation.findingId = "finding:attacker";
          reconciliation.issueIid = 999;
          Object.assign(reconciliation, { disposition: "reuse-active" });
        },
        (projection: Awaited<ReturnType<typeof productionAutoDryRunRoadmapPlanner.plan>>) => {
          projection.reconciliations[0]!.workUnitFingerprint = "a".repeat(64);
          projection.deferredWorkUnitFingerprints = ["a".repeat(64)];
        },
      ]) {
        await expect(
          createAutoDryRun(host.source, {
            plan: async (source) => {
              const projection = structuredClone(
                await productionAutoDryRunRoadmapPlanner.plan(source),
              );
              mutate(projection);
              projection.digest = roadmapDigest(projection);
              return projection;
            },
          }),
        ).rejects.toThrow("invalid-roadmap-preview");
      }
      const blockedWorkflow = structuredClone(first);
      blockedWorkflow.decision.disposition = "blocked";
      blockedWorkflow.decision.confidence = "blocked";
      blockedWorkflow.operations = [];
      blockedWorkflow.draftMergeRequestDestination = null;
      blockedWorkflow.roadmapPlanSha256 = null;
      expect(() => decodeAutoDryRunResult(rehashResult(blockedWorkflow))).toThrow("invalid-source");
      expect(first.decision.deliveryMode).toBe("none");
      const injectedDraft = structuredClone(first);
      const injectedDestination = {
        provider: "gitlab" as const,
        projectIdentitySha256: first.tracker!.projectIdentitySha256,
        targetBranch: first.repository.targetBranch!,
      };
      const semanticIdentitySha256 = canonicalDigest({
        contract: "docsfab-auto-dry-run-delivery-v1",
        repositoryRevision: first.repository.revision,
        projectIdentitySha256: injectedDestination.projectIdentitySha256,
        targetBranch: injectedDestination.targetBranch,
        workUnitFingerprint: first.assessment.selectedWorkUnitFingerprint!,
        workflow: first.decision.workflow!,
      });
      const sourceBranch = `docsfab-run/auto-${semanticIdentitySha256.slice(0, 16)}`;
      injectedDraft.draftMergeRequestDestination = injectedDestination;
      injectedDraft.operations.push({
        key: `draft-mr:${canonicalDigest({ semanticIdentitySha256, sourceBranch }).slice(0, 32)}`,
        action: "draft-mr",
        target: {
          kind: "draft-merge-request",
          identitySha256: canonicalDigest(injectedDestination),
          issueIid: null,
          targetBranch: injectedDestination.targetBranch,
          sourceBranch,
        },
        evidenceIds: ["tracker-observation", "roadmap-plan"],
        performsMutation: false,
      });
      expect(() => decodeAutoDryRunResult(rehashResult(injectedDraft))).toThrow("invalid-source");
      const forgedDelivery = structuredClone(injectedDraft);
      forgedDelivery.decision.deliveryMode = "local-patch";
      expect(() => decodeAutoDryRunResult(rehashResult(forgedDelivery))).toThrow("invalid-source");
      await expect(
        createAutoDryRun(host.source, {
          plan: async (source) => {
            const projection = structuredClone(
              await productionAutoDryRunRoadmapPlanner.plan(source),
            );
            if (projection.mutationPlan?.operations[0]) {
              projection.mutationPlan.operations[0].materialBytes += 1;
            } else {
              projection.planning.digest = "f".repeat(64);
            }
            projection.digest = roadmapDigest(projection);
            return projection;
          },
        }),
      ).rejects.toThrow("invalid-roadmap-preview");
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls.filter((call) => call.url.includes("/issues?"))).toHaveLength(1);
      expect(
        calls.every((call) => call.method === "GET" && call.token === "host-specific-token"),
      ).toBe(true);
      expect(await gitStatus(fixture)).toBe(before);
    } finally {
      await host.dispose();
    }
  });

  it("keeps major decisions and operation keys stable across unchanged fresh observations", async () => {
    const fixture = await repositoryFixture(true);
    const calls: string[] = [];
    const reads = mockHostReads(calls);
    const firstHost = await assessAutoDryRunHostWithDependencies(
      {
        mode: "dry-run",
        repositoryPath: fixture,
        revision: "HEAD",
        json: true,
      },
      reads,
    );
    expect(firstHost.status).toBe("ready");
    if (firstHost.status !== "ready") throw new Error("expected first ready assessment");
    const firstProjection = await productionAutoDryRunRoadmapPlanner.plan(firstHost.source);
    const first = await createAutoDryRun(firstHost.source, { plan: async () => firstProjection });
    await firstHost.dispose();

    const secondHost = await assessAutoDryRunHostWithDependencies(
      {
        mode: "dry-run",
        repositoryPath: fixture,
        revision: "HEAD",
        json: true,
      },
      reads,
    );
    expect(secondHost.status).toBe("ready");
    if (secondHost.status !== "ready") throw new Error("expected second ready assessment");
    await expect(
      createAutoDryRun(secondHost.source, { plan: async () => firstProjection }),
    ).rejects.toThrow("invalid-roadmap-preview");
    const output: string[] = [];
    const second = await runAutoDryRunCli(
      ["--dry-run", "--repo", fixture, "--revision", "HEAD", "--json"],
      {
        assess: async () => secondHost,
        roadmapPlanner: productionAutoDryRunRoadmapPlanner,
        log: (message) => output.push(message),
      },
    );
    expect(second.repository).toEqual(first.repository);
    expect(second.decision.disposition).toBe(first.decision.disposition);
    expect(second.decision.workflow).toBe(first.decision.workflow);
    expect(second.decision.reasonCode).toBe(first.decision.reasonCode);
    expect(second.operations.map((item) => item.key)).toEqual(
      first.operations.map((item) => item.key),
    );
    expect(JSON.parse(output[0]!)).toEqual(second);
    expect(calls.filter((url) => url.includes("/issues?"))).toHaveLength(2);
  });

  it("surfaces project-config-untracked when .docsfab.json exists but is not in HEAD", async () => {
    const fixture = await repositoryFixture(true);
    await git(fixture, ["rm", "--cached", "-q", ".docsfab.json"]);
    await git(fixture, ["commit", "-qm", "untrack project config"]);
    const before = await gitStatus(fixture);
    const host = await assessAutoDryRunHostWithDependencies(
      {
        mode: "dry-run",
        repositoryPath: fixture,
        revision: "HEAD",
        json: true,
      },
      mockHostReads([]),
    );
    try {
      expect(host.status).toBe("needs-input");
      if (host.status === "needs-input") {
        expect(host.input.reasonCode).toBe(PROJECT_CONFIG_UNTRACKED_CODE);
        expect(host.input.openInputIds).toEqual(["gitlab-default-target"]);
      }
      expect(await gitStatus(fixture)).toBe(before);
    } finally {
      await host.dispose();
    }
  });

  it("reads project policy from the selected revision, not a dirty checkout replacement", async () => {
    const fixture = await repositoryFixture(true);
    await writeFile(
      join(fixture, ".docsfab.json"),
      canonicalJson({
        schemaVersion: 1,
        gitlab: { remote: "hostile", defaultBranch: "hostile-default" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      }),
    );
    const before = await gitStatus(fixture);
    const calls: string[] = [];
    const host = await assessAutoDryRunHostWithDependencies(
      {
        mode: "dry-run",
        repositoryPath: fixture,
        revision: "HEAD",
        json: true,
      },
      mockHostReads(calls),
    );
    try {
      expect(host.status).toBe("ready");
      expect(calls.some((url) => url.includes("gitlab.example.com"))).toBe(true);
      expect(await gitStatus(fixture)).toBe(before);
    } finally {
      await host.dispose();
    }
  });

  it("rejects an untrusted remote before credential lookup or network egress", async () => {
    const fixture = await repositoryFixture(true);
    await git(fixture, [
      "remote",
      "set-url",
      "origin",
      "https://evil.example.com/group/project.git",
    ]);
    const before = await gitStatus(fixture);
    let tokenLookups = 0;
    let fetches = 0;
    const prior = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = "ambient-must-not-egress";
    try {
      const host = await assessAutoDryRunHostWithDependencies(
        {
          mode: "dry-run",
          repositoryPath: fixture,
          revision: "HEAD",
          json: true,
        },
        {
          trustedGitLabHost: () => "gitlab.example.com",
          tokenForHost: async () => {
            tokenLookups += 1;
            return "ambient-must-not-egress";
          },
          fetch: async () => {
            fetches += 1;
            throw new Error("unexpected egress");
          },
          managedStateLookup: () => ({
            authority: "unavailable",
            lookup: createManagedIssueStateLookupV1([]),
          }),
        },
      );
      try {
        expect(host.status).toBe("needs-input");
        if (host.status === "needs-input") {
          expect(host.input.reasonCode).toBe("managed-tracker-observation-required");
        }
      } finally {
        await host.dispose();
      }
      expect(tokenLookups).toBe(0);
      expect(fetches).toBe(0);
      expect(await gitStatus(fixture)).toBe(before);
    } finally {
      if (prior === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = prior;
    }
  });

  it("rejects a mixed-case or single-label remote host even when trusted", async () => {
    for (const remoteHost of ["GitLab.Example.com", "gitlab"]) {
      const fixture = await repositoryFixture(true);
      await git(fixture, ["remote", "set-url", "origin", `git@${remoteHost}:group/project.git`]);
      let tokenLookups = 0;
      const host = await assessAutoDryRunHostWithDependencies(
        {
          mode: "dry-run",
          repositoryPath: fixture,
          revision: "HEAD",
          json: true,
        },
        {
          ...mockHostReads([]),
          trustedGitLabHost: () => remoteHost,
          tokenForHost: async () => {
            tokenLookups += 1;
            return "host-specific-token";
          },
        },
      );
      try {
        expect(host.status, remoteHost).toBe("needs-input");
        if (host.status === "needs-input") {
          expect(host.input.reasonCode).toBe("managed-tracker-observation-required");
        }
      } finally {
        await host.dispose();
      }
      expect(tokenLookups, remoteHost).toBe(0);
    }
  });

  it("rejects provider default-branch drift before observing issues", async () => {
    const fixture = await repositoryFixture(true);
    const calls: string[] = [];
    const host = await assessAutoDryRunHostWithDependencies(
      {
        mode: "dry-run",
        repositoryPath: fixture,
        revision: "HEAD",
        json: true,
      },
      mockHostReads(calls, [], "restored-receipt-evidence", "renamed-default"),
    );
    try {
      expect(host.status).toBe("needs-input");
      expect(calls.filter((url) => url.includes("/issues?"))).toHaveLength(0);
      expect(calls).toHaveLength(1);
    } finally {
      await host.dispose();
    }
  });

  it("returns truthful needs-input after restart when managed markers lack restored receipts", async () => {
    const fixture = await repositoryFixture(true);
    const markerMaterial = {
      schemaVersion: 1 as const,
      repositoryKeyDigest: "a".repeat(64),
      findingFingerprint: "b".repeat(64),
    };
    const marker = { ...markerMaterial, identityDigest: roadmapDigest(markerMaterial) };
    const calls: string[] = [];
    const host = await assessAutoDryRunHostWithDependencies(
      {
        mode: "dry-run",
        repositoryPath: fixture,
        revision: "HEAD",
        json: true,
      },
      mockHostReads(
        calls,
        [
          {
            iid: 7,
            state: "opened",
            updated_at: "2026-08-05T18:00:00.000Z",
            title: "Managed issue",
            description: renderManagedIssueMarker(marker),
            labels: ["docsfab-roadmap::managed"],
            milestone: null,
          },
        ],
        "unavailable",
      ),
    );
    try {
      expect(host.status).toBe("needs-input");
      if (host.status === "needs-input") {
        expect(host.input).toMatchObject({
          reasonCode: "managed-state-receipts-required",
          openInputIds: ["gitlab-managed-state-receipts"],
        });
      }
      expect(calls.some((url) => url.endsWith("/issues/7/links?per_page=100"))).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it("disposes the immutable workspace when the exact roadmap seam fails", async () => {
    const fixture = await repositoryFixture(true);
    const before = await gitStatus(fixture);
    let source: Parameters<typeof autoDryRunHostWorkspace>[0] | undefined;
    await expect(
      runAutoDryRunCli(["--dry-run", "--repo", fixture, "--json"], {
        assess: async (arguments_) => {
          const host = await assessAutoDryRunHostWithDependencies(arguments_, mockHostReads([]));
          if (host.status === "ready") source = host.source;
          return host;
        },
        roadmapPlanner: {
          plan: async () => {
            throw new Error("forced planner failure");
          },
        },
        log: () => undefined,
      }),
    ).rejects.toThrow("forced planner failure");
    expect(source).toBeDefined();
    expect(() => autoDryRunHostWorkspace(source!)).toThrow("no longer active");
    expect(await gitStatus(fixture)).toBe(before);
  });
});

async function repositoryFixture(ready = false): Promise<string> {
  const root = await temporary.create("docsfab-auto-dry-run-");
  await initFixtureRepo(root, undefined, { branch: "main" });
  await writeFile(join(root, "README.md"), "# Fixture\n");
  if (ready) {
    await mkdir(join(root, "guide"));
    await writeFile(join(root, "guide", "start.md"), "# Start\n\n## Run\n\n1. Run it.\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: {},
      }),
    );
    await writeFile(
      join(root, DOCUMENTATION_MATURITY_HOST_POLICY_PATH),
      canonicalJson({
        schemaVersion: 1,
        kind: "docsfab-documentation-maturity-host-policy",
        productNeed: {
          repositoryType: "library",
          documentationType: "developer-reference",
          gateIds: ["G1", "G2", "G3", "G4", "G5"],
          decision: {
            id: "fixture-required",
            need: "required",
            authorityId: "fixture-product-governance",
            decidedAt: "2026-08-05T12:00:00.000Z",
            evidenceSha256: canonicalDigest("fixture-required"),
            predecessorDecisionSha256: null,
          },
        },
        modularity: {
          activePolicyId: "fixture-modularity",
          activePolicyVersion: "1",
          policies: [
            {
              id: "fixture-modularity",
              version: "1",
              maximumSectionsPerDocument: 32,
              maximumSectionDepth: 8,
            },
          ],
        },
      }),
    );
    await writeFile(
      join(root, ".docsfab.json"),
      canonicalJson({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      }),
    );
  }
  await commitFixture(root, "fixture");
  if (ready) {
    await git(root, ["remote", "add", "origin", "https://gitlab.example.com/group/project.git"]);
  }
  return root;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockHostReads(
  calls: string[],
  issues: unknown[] = [],
  managedAuthority: "restored-receipt-evidence" | "unavailable" = "restored-receipt-evidence",
  projectDefaultBranch = "main",
): AutoDryRunHostReadDependencies {
  return {
    trustedGitLabHost: () => "gitlab.example.com",
    tokenForHost: async () => "host-specific-token",
    fetch: async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("private-token")).toBe("host-specific-token");
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v4/projects/group%2Fproject"))
        return jsonResponse({
          id: 42,
          path_with_namespace: "group/project",
          default_branch: projectDefaultBranch,
        });
      if (url.includes("/repository/commits/")) {
        return jsonResponse({ id: decodeURIComponent(url.split("/").at(-1)!) });
      }
      if (url.includes("/issues?")) return jsonResponse(issues);
      if (/\/issues\/[1-9][0-9]*\/links\?per_page=100$/u.test(url)) return jsonResponse([]);
      throw new Error(`Unexpected fetch ${url}`);
    },
    managedStateLookup: () => ({
      authority: managedAuthority,
      lookup: createManagedIssueStateLookupV1([]),
    }),
  };
}

function rehashResult<T extends { resultSha256: string }>(value: T): T {
  const { resultSha256: _resultSha256, ...body } = value;
  return { ...value, resultSha256: canonicalDigest(body) };
}

async function gitStatus(root: string): Promise<string> {
  return await git(root, ["status", "--porcelain=v1"], { trim: false });
}
