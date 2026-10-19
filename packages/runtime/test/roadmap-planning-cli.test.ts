// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  GitLabRoadmapReader,
  decodeRoadmapPlanningInput,
  inspectGitReleaseBoundary,
  roadmapDigest,
  parseRoadmapPlanCliArguments,
  runRoadmapPlanCli,
  sanitizeGitLabIssue,
  type RoadmapHealthPlanningInput,
} from "../src/roadmap/index.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

const REVISION = "a".repeat(40);
const CONTENT = "b".repeat(64);
const T0 = "2026-08-05T00:00:00.000Z";
const T1 = "2026-08-05T00:01:00.000Z";

describe("roadmap planning CLI and GitLab read-only edge", () => {
  it("parses only the three fixed command forms", () => {
    expect(
      parseRoadmapPlanCliArguments([
        "--mode",
        "release",
        "--since",
        "v1",
        "--input",
        "release.json",
      ]),
    ).toMatchObject({ mode: "release", since: "v1", revision: "HEAD" });
    expect(
      parseRoadmapPlanCliArguments([
        "--mode",
        "health",
        "--scope",
        "docs/api",
        "--input",
        "health.json",
        "--limit",
        "5",
      ]),
    ).toMatchObject({ mode: "health", scope: "docs/api", proposalCap: 5 });
    expect(
      parseRoadmapPlanCliArguments(["--sweep", "ledger.json", "--input", "sweep.json", "--json"]),
    ).toMatchObject({ mode: "sweep", json: true });
    expect(() =>
      parseRoadmapPlanCliArguments(["--mode", "release", "--input", "release.json"]),
    ).toThrow("--since");
    expect(() =>
      parseRoadmapPlanCliArguments(["--mode", "health", "--since", "v1", "--input", "health.json"]),
    ).toThrow("release-only");
    expect(() =>
      parseRoadmapPlanCliArguments([
        "--mode",
        "health",
        "--scope",
        "/Users/private",
        "--input",
        "health.json",
      ]),
    ).toThrow("safe repository-relative");
    expect(() =>
      parseRoadmapPlanCliArguments(["--mode", "health", "--input", "one", "--input", "two"]),
    ).toThrow("duplicated");
  });

  it("sanitizes raw GitLab issue metadata to bounded identities and markers", () => {
    const fingerprint = "c".repeat(64);
    const material = "d".repeat(64);
    const result = sanitizeGitLabIssue({
      iid: 45,
      state: "opened",
      updated_at: T0,
      title: "Sensitive title",
      description: `Sensitive body [docsfab-fingerprint:${fingerprint}] [docsfab-material:${material}]`,
      labels: ["documentation", "p1"],
      milestone: { id: 2, title: "Wave" },
    });
    expect(result).toMatchObject({
      iid: 45,
      findingFingerprints: [fingerprint],
      materialEvidenceDigests: [material],
    });
    expect(JSON.stringify(result)).not.toContain("Sensitive");
    expect(result.identityDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("uses bounded GET-only pagination and never sends a token in the URL", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      const page = new URL(url).searchParams.get("page");
      return new Response(
        JSON.stringify(
          page === "1"
            ? [
                {
                  iid: 1,
                  state: "opened",
                  updated_at: T0,
                  title: "one",
                  description: "",
                  labels: [],
                  milestone: null,
                },
              ]
            : [
                {
                  iid: 2,
                  state: "closed",
                  updated_at: T0,
                  title: "two",
                  description: "",
                  labels: [],
                  milestone: null,
                },
              ],
        ),
        { status: 200, headers: page === "1" ? { "x-next-page": "2" } : {} },
      );
    });
    const project = {
      provider: "gitlab",
      host: "gitlab.example.com",
      fullPath: "group/project",
      projectId: 7,
    };
    const reader = new GitLabRoadmapReader({
      project,
      baseUrl: "https://gitlab.example.com",
      token: "owner-secret",
      fetch: fetchMock,
    });
    const issues = await reader.observe(project);
    expect(issues.map((item) => item.iid)).toEqual([1, 2]);
    expect(requests).toHaveLength(2);
    expect(requests.every((item) => item.init?.method === "GET")).toBe(true);
    expect(requests.every((item) => !item.url.includes("owner-secret"))).toBe(true);
    expect(
      requests.every(
        (item) =>
          (item.init?.headers as Record<string, string> | undefined)?.["PRIVATE-TOKEN"] ===
          "owner-secret",
      ),
    ).toBe(true);
  });

  it("runs the production command as a dry-run without repository or tracker writes", async () => {
    const input = planningInput();
    const observed: string[] = [];
    const output: string[] = [];
    const artifact = await runRoadmapPlanCli(
      [
        "--mode",
        "health",
        "--input",
        "input.json",
        "--repo",
        ".",
        "--revision",
        REVISION,
        "--json",
      ],
      {
        inspectRepository: async () => ({ revision: REVISION, contentDigest: CONTENT }),
        readJson: async () => input,
        issueReader: {
          observe: async (project) => {
            observed.push(`${project.provider}:${project.projectId}`);
            return [];
          },
        },
        log: (message) => output.push(message),
        environment: {},
        trustedProject: input.project,
        trustedSourceDigest: roadmapDigest({ source: decodeRoadmapPlanningInput(input) }),
      },
    );
    expect(observed).toEqual(["gitlab:422255"]);
    expect(artifact).toMatchObject({ readOnly: true, authorization: null });
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ kind: "docsfab-roadmap-plan", readOnly: true });
  });

  it("rejects non-GET base URLs, wrong providers, malformed pagination, and stale CLI identity", async () => {
    const project = {
      provider: "gitlab" as const,
      host: "gitlab.example.com",
      fullPath: "group/project",
      projectId: 7,
    };
    expect(
      () => new GitLabRoadmapReader({ project, baseUrl: "http://gitlab.example.com" }),
    ).toThrow("trusted project origin");
    const reader = new GitLabRoadmapReader({
      project,
      baseUrl: "https://gitlab.example.com",
      fetch: async () => new Response("[]", { status: 200, headers: { "x-next-page": "9" } }),
    });
    await expect(
      reader.observe({
        provider: "gitlab",
        host: "gitlab.example.com",
        fullPath: "group/project",
        projectId: 7,
      }),
    ).rejects.toThrow("pagination");
    await expect(
      reader.observe({
        provider: "forgejo",
        host: "forgejo.example.com",
        fullPath: "group/project",
        projectId: 7,
      }),
    ).rejects.toThrow("project identity");

    await expect(
      runRoadmapPlanCli(["--mode", "health", "--input", "input.json"], {
        inspectRepository: async () => ({ revision: "f".repeat(40), contentDigest: CONTENT }),
        readJson: async () => planningInput(),
        issueReader: { observe: async () => [] },
        log: () => undefined,
      }),
    ).rejects.toThrow("stale");
  });

  it("rejects credential-destination and inert-shape attacks before any request or trap", async () => {
    const project = {
      provider: "gitlab" as const,
      host: "gitlab.example.com",
      fullPath: "group/project",
      projectId: 7,
    };
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    for (const baseUrl of [
      "https://evil.example.com",
      "https://gitlab.example.com:8443",
      "https://user@gitlab.example.com",
      "https://gitlab.example.com/path",
      "https://gitlab.example.com/?next=evil",
      "https://gitlab.example.com/#fragment",
    ])
      expect(
        () =>
          new GitLabRoadmapReader({ project, baseUrl, token: "owner-secret", fetch: fetchMock }),
      ).toThrow("trusted project origin");
    expect(fetchMock).not.toHaveBeenCalled();

    const reader = new GitLabRoadmapReader({ project, token: "owner-secret", fetch: fetchMock });
    await expect(reader.observe({ ...project, host: "evil.example.com" })).rejects.toThrow(
      "trusted credential destination",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    let projectTraps = 0;
    const projectProxy = new Proxy(project, {
      get: (target, key, receiver) => {
        projectTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(reader.observe(projectProxy)).rejects.toThrow("project identity");
    expect(projectTraps).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    let issueTraps = 0;
    const issueProxy = new Proxy(
      { iid: 1 },
      {
        get: (target, key, receiver) => {
          issueTraps += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => sanitizeGitLabIssue(issueProxy)).toThrow("metadata");
    expect(issueTraps).toBe(0);

    const issue = {
      iid: 1,
      state: "opened",
      updated_at: T0,
      title: "one",
      description: "",
      labels: [],
      milestone: null,
    };
    let labelHits = 0;
    const labels = [...issue.labels];
    Object.defineProperty(labels, "0", {
      enumerable: true,
      get: () => {
        labelHits += 1;
        return "secret";
      },
    });
    Object.defineProperty(labels, "length", { value: 1 });
    expect(() => sanitizeGitLabIssue({ ...issue, labels })).toThrow("labels is invalid");
    expect(labelHits).toBe(0);

    let milestoneTraps = 0;
    const milestone = new Proxy(
      { id: 1, title: "m" },
      {
        get: (target, key, receiver) => {
          milestoneTraps += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => sanitizeGitLabIssue({ ...issue, milestone })).toThrow("milestone metadata");
    expect(milestoneTraps).toBe(0);

    const trustedInput = planningInput();
    const hostileInput = structuredClone(trustedInput);
    hostileInput.project.host = "evil.example.com";
    hostileInput.docAudit.projectIdentityDigest = roadmapDigest(hostileInput.project);
    hostileInput.docAudit.digest = roadmapDigest(hostileInput.docAudit);
    const observe = vi.fn(async () => []);
    await expect(
      runRoadmapPlanCli(["--mode", "health", "--input", "input.json"], {
        inspectRepository: async () => ({ revision: REVISION, contentDigest: CONTENT }),
        readJson: async () => hostileInput,
        issueReader: { observe },
        log: () => undefined,
        environment: { GITLAB_TOKEN: "owner-secret" },
        trustedProject: trustedInput.project,
        trustedSourceDigest: roadmapDigest({ source: decodeRoadmapPlanningInput(hostileInput) }),
      }),
    ).rejects.toThrow("host-owned trusted project");
    expect(observe).not.toHaveBeenCalled();

    const authenticInput = planningInput();
    const substitutedInput = structuredClone(authenticInput);
    substitutedInput.candidates[0]!.draft!.summary = "Attacker-substituted reviewed material.";
    substitutedInput.docAudit.findings[0]!.candidateDigest = roadmapDigest(
      substitutedInput.candidates[0]!,
    );
    substitutedInput.docAudit.digest = roadmapDigest(substitutedInput.docAudit);
    const sourceObserve = vi.fn(async () => []);
    await expect(
      runRoadmapPlanCli(["--mode", "health", "--input", "input.json"], {
        inspectRepository: async () => ({ revision: REVISION, contentDigest: CONTENT }),
        readJson: async () => substitutedInput,
        issueReader: { observe: sourceObserve },
        log: () => undefined,
        environment: {},
        trustedProject: authenticInput.project,
        trustedSourceDigest: roadmapDigest({ source: decodeRoadmapPlanningInput(authenticInput) }),
      }),
    ).rejects.toThrow("reviewed source");
    expect(sourceObserve).not.toHaveBeenCalled();
  });

  it("independently enumerates additions, deletions, modifications, and renames in the exact Git boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-roadmap-boundary-"));
    try {
      const from = await initFixtureRepo(
        root,
        { "deleted.md": "delete\n", "renamed.md": "rename\n", "modified.md": "before\n" },
        { message: "base" },
      );
      await rm(join(root, "deleted.md"));
      await rename(join(root, "renamed.md"), join(root, "moved.md"));
      await writeFile(join(root, "modified.md"), "after\n");
      await writeFile(join(root, "added.md"), "add\n");
      const to = await commitFixture(root, "changes");
      const boundary = await inspectGitReleaseBoundary(root, from, to, {
        provider: "gitlab",
        host: "gitlab.example.com",
        fullPath: "group/project",
        projectId: 7,
      });
      expect(
        boundary.changes.map((change) => [change.status, change.previousPath, change.path]),
      ).toEqual([
        ["added", undefined, "added.md"],
        ["deleted", undefined, "deleted.md"],
        ["modified", undefined, "modified.md"],
        ["renamed", "renamed.md", "moved.md"],
      ]);
      expect(boundary.digest).toBe(roadmapDigest(boundary));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function planningInput(): RoadmapHealthPlanningInput {
  const project = {
    provider: "gitlab",
    host: "gitlab.example.com",
    fullPath: "group/docsfab",
    projectId: 422_255,
  };
  const candidate = {
    id: "candidate:one",
    category: "documentation-gap",
    severity: "p1" as const,
    disposition: "repair" as const,
    unitIds: ["unit:one"],
    affectedPaths: ["docs/one.md"],
    evidenceDigest: "e".repeat(64),
    rank: { impact: 3, urgency: 2, dependency: 1, scope: 2, verificationCost: 1, confidence: 0.9 },
    review: {
      disposition: "accepted" as const,
      rationaleCode: "review-passed",
      evidenceDigest: "f".repeat(64),
    },
    draft: {
      kind: "issue" as const,
      title: "Repair documentation",
      summary: "Repair the evidence-backed gap.",
      acceptanceCriteria: ["The gap is repaired."],
      verification: ["Run documentation checks."],
      evidencePaths: ["docs/one.md"],
      selfContained: true,
    },
  };
  const unit = {
    id: "unit:one",
    kind: "doc-audit" as const,
    path: "docs/one.md",
    evidenceDigest: "e".repeat(64),
  };
  const docAudit = {
    kind: "authenticated-doc-audit-package" as const,
    schemaVersion: 1 as const,
    runId: "run:audit",
    workflow: "review-documentation" as const,
    status: "succeeded" as const,
    repositoryRevision: REVISION,
    repositoryContentDigest: CONTENT,
    projectIdentityDigest: roadmapDigest(project),
    findings: [
      {
        id: candidate.id,
        units: [unit],
        affectedPaths: candidate.affectedPaths,
        evidenceDigest: candidate.evidenceDigest,
        candidateDigest: roadmapDigest(candidate),
      },
    ],
    digest: "0".repeat(64),
  };
  docAudit.digest = roadmapDigest(docAudit);
  return {
    kind: "docsfab-roadmap-planning-input",
    schemaVersion: 1,
    mode: "health",
    repository: { revision: REVISION, contentDigest: CONTENT },
    project,
    observedAt: T0,
    expiresAt: T1,
    units: [unit],
    candidates: [candidate],
    semanticReconciliation: [],
    proposalCap: 5,
    docAudit,
  };
}
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
