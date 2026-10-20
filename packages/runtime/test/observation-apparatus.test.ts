// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createKnowledgeAcceptedSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
} from "../src/canon/index.js";
import { createConfinedToolSet, governedSkillVirtualRoot } from "../src/harness/confined-tools.js";
import {
  inspectKnowledgeSnapshotResume,
  instructionSha256,
  KnowledgeResumeError,
  assertResumeMatchesOriginal,
} from "../src/cli/knowledge-resume.js";
import { assessChangeImpact } from "../src/search/change-impact.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import {
  fetchDocumentationSection,
  MAX_RETURNED_SECTION_BYTES,
  MAX_SECTION_SOURCE_BYTES,
} from "../src/search/section-fetch.js";
import { buildTalkTree } from "../src/search/talk-tree.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { normalizeWorkflowSearchEvidence } from "../src/workflow-contracts/search.js";
import { temporaryRoots } from "./helpers/temp.js";
import { initFixtureRepo } from "./helpers/git.js";

const REVISION = "a".repeat(40);
const HASH = "b".repeat(64);
const temporary = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

async function docsRepo(): Promise<string> {
  const root = await temporary.create("docsfab-observation-");
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "docs", "api.md"),
    "# API\n\n## Authentication\n\nUse a token.\n\n## Limits\n\nTen requests.\n",
    "utf8",
  );
  await writeFile(join(root, "src", "api.ts"), "export const api = 1;\n", "utf8");
  await writeFile(join(root, "package.json"), '{"private":true}\n', "utf8");
  return root;
}

async function preparedDocsRepo(extra?: (source: string) => Promise<void>): Promise<{
  source: string;
  workspace: RepositoryWorkspace;
  inventory: Awaited<ReturnType<typeof buildRepositoryDiscoveryInventory>>;
}> {
  const source = await docsRepo();
  await extra?.(source);
  await initFixtureRepo(source, {}, { message: "docs" });
  const workspace = await prepareRepositoryWorkspace(source, "HEAD");
  workspaces.push(workspace);
  return {
    source,
    workspace,
    inventory: await buildRepositoryDiscoveryInventory({ workspace }),
  };
}

describe("talk tree and get-section", () => {
  it("projects page headings and fetches one section", async () => {
    const { workspace, inventory } = await preparedDocsRepo();
    const root = workspace.path;
    const tree = await buildTalkTree({
      repositoryPath: root,
      repositoryRevision: workspace.revision,
    });
    expect(tree.kind).toBe("docsfab-talk-tree");
    expect(tree.pages.map((page) => page.path)).toContain("docs/api.md");
    const api = tree.pages.find((page) => page.path === "docs/api.md")!;
    expect(api.headings.map((heading) => heading.headingId)).toEqual(
      expect.arrayContaining(["api", "authentication", "limits"]),
    );

    const tools = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: false,
      repositoryRevision: workspace.revision,
      workspaceSnapshotSha256: inventory.inventorySha256,
      repositoryWorkspace: workspace,
      repositoryInventory: inventory,
      search: getWorkflow("create-documentation").steps.find((step) => step.search)!.search,
    });
    const getSection = tools.definitions.find((tool) => tool.name === "get_section")!;
    const result = (await getSection.execute(
      "test-get-section",
      { path: "docs/api.md", headingId: "authentication" },
      undefined,
      undefined,
      undefined as never,
    )) as { content: Array<{ type: string; text?: string }> };
    const payload = JSON.parse(result.content[0]!.text ?? "{}") as {
      headingId: string;
      bytes: string;
      digest: string;
      repositoryRevision: string;
      workspaceSnapshotSha256: string;
      evidenceSha256: string;
    };
    expect(payload.headingId).toBe("authentication");
    expect(payload.bytes).toContain("Use a token.");
    expect(payload.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(payload).toMatchObject({
      repositoryRevision: workspace.revision,
      workspaceSnapshotSha256: inventory.inventorySha256,
    });
    expect(payload.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("names the refusing capability, its code, and the read to make instead", async () => {
    const { workspace, inventory } = await preparedDocsRepo(async (source) => {
      await writeFile(join(source, "mkdocs.yml"), "nav:\n  - docs/api.md\n", "utf8");
      // An unrelated page the content index refuses, so no section can be served.
      await writeFile(join(source, "docs", "broken.md"), "# Broken\n\n<img src=logo.png>\n");
    });
    const tools = await createConfinedToolSet({
      workspacePath: workspace.path,
      allowWrite: false,
      repositoryRevision: workspace.revision,
      workspaceSnapshotSha256: inventory.inventorySha256,
      repositoryWorkspace: workspace,
      repositoryInventory: inventory,
      search: getWorkflow("update-documentation").steps[0]!.search,
    });
    const getSection = tools.definitions.find((tool) => tool.name === "get_section")!;
    expect(getSection.description).not.toContain("talk tree");
    const refusal = async (parameters: Record<string, unknown>): Promise<string> => {
      try {
        await getSection.execute(
          "get-section",
          parameters,
          undefined,
          undefined,
          undefined as never,
        );
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("Expected get_section to refuse.");
    };

    const unavailable = await refusal({ path: "docs/api.md", headingId: "authentication" });
    expect(unavailable).toBe(
      "DocsFab get_section refused (get-section-index-unavailable, content index unsupported-internal-target): DocsFab could not build the documentation section index for this workspace. Read documentation pages with read instead.",
    );
    expect(unavailable).not.toContain(workspace.path);
    expect(tools.getFailureCategories()).toEqual([
      { category: "expected-missing-probe", count: 1 },
    ]);
  });

  it("refuses a missing heading and a navigation file as not-found, with the read to make", async () => {
    const { workspace, inventory } = await preparedDocsRepo(async (source) => {
      await writeFile(join(source, "mkdocs.yml"), "nav:\n  - docs/api.md\n", "utf8");
    });
    const tools = await createConfinedToolSet({
      workspacePath: workspace.path,
      allowWrite: false,
      repositoryRevision: workspace.revision,
      workspaceSnapshotSha256: inventory.inventorySha256,
      repositoryWorkspace: workspace,
      repositoryInventory: inventory,
      search: getWorkflow("update-documentation").steps[0]!.search,
    });
    const getSection = tools.definitions.find((tool) => tool.name === "get_section")!;
    const notFound =
      "DocsFab get_section refused (get-section-not-found): the path names no page in the documentation section index with a heading of that id. Read the page with read instead of retrying get_section; read also serves pages outside the index, such as navigation files, untracked files, and governed assets.";
    for (const parameters of [
      { path: "docs/api.md", headingId: "pagination" },
      { path: "mkdocs.yml", headingId: "nav" },
    ]) {
      await expect(
        getSection.execute("get-section", parameters, undefined, undefined, undefined as never),
      ).rejects.toThrow(notFound);
    }
  });

  it("admits every path form read admits and codes every path read refuses", async () => {
    const { workspace, inventory } = await preparedDocsRepo();
    const tools = await createConfinedToolSet({
      workspacePath: workspace.path,
      allowWrite: false,
      repositoryRevision: workspace.revision,
      workspaceSnapshotSha256: inventory.inventorySha256,
      repositoryWorkspace: workspace,
      repositoryInventory: inventory,
      search: getWorkflow("update-documentation").steps[0]!.search,
    });
    const tool = (name: string) =>
      tools.definitions.find((definition) => definition.name === name)!;
    const call = (name: string, parameters: Record<string, unknown>) =>
      tool(name).execute("path-form", parameters, undefined, undefined, undefined as never);
    const refusal = async (name: string, parameters: Record<string, unknown>) => {
      try {
        await call(name, parameters);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error(`Expected ${name} to refuse.`);
    };

    // The forms read admits for the same page serve the same section.
    for (const path of ["docs/api.md", "./docs/api.md", "/workspace/docs/api.md"]) {
      await call("read", { path });
      const result = (await call("get_section", { path, headingId: "authentication" })) as {
        content: Array<{ text?: string }>;
      };
      expect(JSON.parse(result.content[0]!.text ?? "{}")).toMatchObject({
        path: "docs/api.md",
        headingId: "authentication",
      });
    }
    expect(tools.getFailureCategories()).toEqual([]);

    expect(await refusal("get_section", { path: "docs/missing.md", headingId: "a" })).toBe(
      "DocsFab get_section refused (get-section-not-found): the path names no page in the documentation section index with a heading of that id. Read the page with read instead of retrying get_section; read also serves pages outside the index, such as navigation files, untracked files, and governed assets.",
    );
    for (const [path, rule] of [
      ["../outside.md", "traversal"],
      ["/etc/hosts", "absolute-path"],
    ] as const) {
      expect(await refusal("get_section", { path, headingId: "a" })).toBe(
        `DocsFab get_section refused (get-section-denied-path, path rule ${rule}): the path is outside what this step may read. Pass a repository-relative page path, such as docs/guide.md.`,
      );
    }
    // The same categories read records for the same paths, and no tool defect.
    for (const path of ["docs/missing.md", "../outside.md", "/etc/hosts"]) {
      await refusal("read", { path });
    }
    expect(tools.getFailureCategories()).toEqual([
      { category: "denied-path", count: 4 },
      { category: "expected-missing-probe", count: 2 },
    ]);
  });

  it.each([
    ["with", true],
    ["without", false],
  ] as const)(
    "serves what read serves, %s a repository workspace, and never refuses an admitted path as denied",
    async (_label, attached) => {
      const { workspace, inventory } = await preparedDocsRepo();
      // An untracked link inside the workspace, which read follows.
      await symlink("api.md", join(workspace.path, "docs", "link.md"));
      // A governed skill, which read serves under a virtual path outside the
      // workspace and the section index.
      const skill = await temporary.create("docsfab-observation-skill-");
      await writeFile(join(skill, "SKILL.md"), "# Skill\n\n## Authentication\n\nUse it.\n");
      const tools = await createConfinedToolSet({
        workspacePath: workspace.path,
        allowWrite: false,
        governedSkill: { id: "plan-documentation", directory: skill },
        repositoryRevision: workspace.revision,
        ...(attached
          ? {
              workspaceSnapshotSha256: inventory.inventorySha256,
              repositoryWorkspace: workspace,
              repositoryInventory: inventory,
            }
          : {}),
        search: getWorkflow("update-documentation").steps[0]!.search,
      });
      const call = (name: string, parameters: Record<string, unknown>) =>
        tools.definitions
          .find((definition) => definition.name === name)!
          .execute("path-form", parameters, undefined, undefined, undefined as never);
      const outcome = async (name: string, parameters: Record<string, unknown>) => {
        try {
          return { served: await call(name, parameters) };
        } catch (error) {
          return { refused: (error as Error).message };
        }
      };
      const notFound = /^DocsFab get_section refused \(get-section-not-found\): /u;
      const paths = [
        // Directory forms.
        ".",
        "/workspace",
        "/workspace/",
        "docs",
        "docs/",
        // Read opens these where the file system allows: a trailing slash and
        // a different case on a case-insensitive file system.
        "docs/api.md/",
        "Docs/API.md",
        // A link inside the workspace.
        "docs/link.md",
      ];
      const served: string[] = [];
      for (const path of paths) {
        const read = await outcome("read", { path });
        const section = await outcome("get_section", { path, headingId: "authentication" });
        if ("served" in read) {
          served.push(path);
          // A page read opens serves the same section.
          const result = section.served as { content: Array<{ text?: string }> } | undefined;
          expect(result, `${path}: ${section.refused}`).toBeDefined();
          expect(JSON.parse(result!.content[0]!.text ?? "{}")).toMatchObject({
            path: "docs/api.md",
            headingId: "authentication",
          });
        } else {
          expect(section.refused, path).toMatch(notFound);
        }
      }
      // Read follows the link on every platform, so the served branch runs.
      expect(served).toContain("docs/link.md");
      // Read serves the governed skill page, which has no indexed sections.
      const skillPage = `${governedSkillVirtualRoot("plan-documentation")}/SKILL.md`;
      expect(await outcome("read", { path: skillPage })).toHaveProperty("served");
      expect(
        (await outcome("get_section", { path: skillPage, headingId: "authentication" })).refused,
      ).toMatch(notFound);
      expect(tools.getFailureCategories().map((entry) => entry.category)).not.toContain(
        "denied-path",
      );
      expect(tools.getFailureCategories().map((entry) => entry.category)).not.toContain(
        "tool-defect",
      );
      if (attached) {
        // The fetch itself names a directory not-found, not an unavailable index.
        await expect(
          fetchDocumentationSection(
            {
              repositoryPath: workspace.path,
              repositoryRevision: workspace.revision,
              workspaceSnapshotSha256: inventory.inventorySha256,
              path: "docs",
              headingId: "authentication",
              resolvedPath: join(workspace.path, "docs"),
            },
            { workspace, inventory },
          ),
        ).rejects.toMatchObject({ code: "not-found" });
      }
    },
  );

  it("rejects stale revalidation and resolved paths outside the workspace", async () => {
    const { workspace, inventory } = await preparedDocsRepo();
    const root = workspace.path;
    const authority = { workspace, inventory };
    const first = await fetchDocumentationSection(
      {
        repositoryPath: root,
        repositoryRevision: workspace.revision,
        workspaceSnapshotSha256: inventory.inventorySha256,
        path: "docs/api.md",
        headingId: "authentication",
        resolvedPath: join(root, "docs/api.md"),
      },
      authority,
    );
    await expect(
      fetchDocumentationSection(
        {
          repositoryPath: root,
          repositoryRevision: workspace.revision,
          workspaceSnapshotSha256: "c".repeat(64),
          path: "docs/api.md",
          headingId: "authentication",
          resolvedPath: join(root, "docs/api.md"),
          expectedEvidence: {
            repositoryRevision: first.repositoryRevision,
            workspaceSnapshotSha256: first.workspaceSnapshotSha256,
            evidenceSha256: first.evidenceSha256,
          },
        },
        authority,
      ),
    ).rejects.toMatchObject({ code: "snapshot-changed" });
    await expect(
      fetchDocumentationSection(
        {
          repositoryPath: root,
          repositoryRevision: workspace.revision,
          workspaceSnapshotSha256: inventory.inventorySha256,
          path: "docs/api.md",
          headingId: "authentication",
          resolvedPath: resolve(root, "../outside.md"),
        },
        authority,
      ),
    ).rejects.toMatchObject({ code: "denied-path" });
  });

  it("rejects logical/resolved path substitution and oversized returned sections", async () => {
    const { workspace, inventory } = await preparedDocsRepo();
    await expect(
      fetchDocumentationSection(
        {
          repositoryPath: workspace.path,
          repositoryRevision: workspace.revision,
          workspaceSnapshotSha256: inventory.inventorySha256,
          path: "docs/api.md",
          headingId: "authentication",
          resolvedPath: join(workspace.path, "src/api.ts"),
        },
        { workspace, inventory },
      ),
    ).rejects.toMatchObject({ code: "denied-path" });

    const source = await docsRepo();
    await writeFile(
      join(source, "docs/api.md"),
      `# API\n\n## Authentication\n\n${"a".repeat(MAX_RETURNED_SECTION_BYTES + 1)}\n`,
    );
    await initFixtureRepo(source, {}, { message: "oversize" });
    const oversized = await prepareRepositoryWorkspace(source, "HEAD");
    workspaces.push(oversized);
    const oversizedInventory = await buildRepositoryDiscoveryInventory({ workspace: oversized });
    await expect(
      fetchDocumentationSection(
        {
          repositoryPath: oversized.path,
          repositoryRevision: oversized.revision,
          workspaceSnapshotSha256: oversizedInventory.inventorySha256,
          path: "docs/api.md",
          headingId: "authentication",
          resolvedPath: join(oversized.path, "docs/api.md"),
        },
        { workspace: oversized, inventory: oversizedInventory },
      ),
    ).rejects.toMatchObject({ code: "size-limit-exceeded" });

    const sourceOversize = await docsRepo();
    await writeFile(
      join(sourceOversize, "docs/api.md"),
      `# API\n\n## Authentication\n\n${"b".repeat(MAX_SECTION_SOURCE_BYTES + 1)}\n`,
    );
    await initFixtureRepo(sourceOversize, {}, { message: "source oversize" });
    const sourceOversizeWorkspace = await prepareRepositoryWorkspace(sourceOversize, "HEAD");
    workspaces.push(sourceOversizeWorkspace);
    const sourceOversizeInventory = await buildRepositoryDiscoveryInventory({
      workspace: sourceOversizeWorkspace,
    });
    await expect(
      fetchDocumentationSection(
        {
          repositoryPath: sourceOversizeWorkspace.path,
          repositoryRevision: sourceOversizeWorkspace.revision,
          workspaceSnapshotSha256: sourceOversizeInventory.inventorySha256,
          path: "docs/api.md",
          headingId: "authentication",
          resolvedPath: join(sourceOversizeWorkspace.path, "docs/api.md"),
        },
        { workspace: sourceOversizeWorkspace, inventory: sourceOversizeInventory },
      ),
    ).rejects.toMatchObject({ code: "size-limit-exceeded" });
  });

  it("rejects bytes changed after the authenticated inventory snapshot", async () => {
    const { workspace, inventory } = await preparedDocsRepo();
    await writeFile(
      join(workspace.path, "docs/api.md"),
      "# API\n\n## Authentication\n\nChanged.\n",
    );
    await expect(
      fetchDocumentationSection(
        {
          repositoryPath: workspace.path,
          repositoryRevision: workspace.revision,
          workspaceSnapshotSha256: inventory.inventorySha256,
          path: "docs/api.md",
          headingId: "authentication",
          resolvedPath: join(workspace.path, "docs/api.md"),
        },
        { workspace, inventory },
      ),
    ).rejects.toMatchObject({ code: "snapshot-changed" });
  });
});

describe("change-impact preflight", () => {
  it("rejects direct caller metadata without opaque host admission", async () => {
    const root = await docsRepo();
    await expect(
      assessChangeImpact(
        {
          repositoryPath: root,
          changedPaths: [],
          comparison: { kind: "unknown" },
          workspaceSnapshotSha256: HASH,
          sources: [
            {
              uri: "docs/api.md",
              sha256: HASH,
              role: "current-documentation",
            },
          ],
          bindings: {
            repositoryIdentitySha256: HASH,
            repositoryRevision: REVISION,
            repositoryContentDigestSha256: HASH,
            sourceRunRecordSha256: HASH,
          },
        },
        { kind: "docsfab-change-impact-read-authority" },
      ),
    ).rejects.toMatchObject({ code: "evidence-contradiction" });
  });

  it("indexes a mid-size doc set without treating the talk tree as credential-material", async () => {
    const root = await temporary.create("docsfab-observation-wide-");
    await mkdir(join(root, "planning", "design"), { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      const headings = Array.from(
        { length: 16 },
        (_, heading) => `## Topic ${String(heading)}\n\nParagraph ${String(heading)}.\n`,
      ).join("\n");
      await writeFile(
        join(root, "planning", "design", `decision-${String(index).padStart(2, "0")}.md`),
        `# Decision ${String(index)}\n\n${headings}`,
        "utf8",
      );
    }
    const tree = await buildTalkTree({
      repositoryPath: root,
      repositoryRevision: REVISION,
    });
    expect(tree.pages.length).toBe(40);
    expect(tree.pages[0]?.headings.length).toBeGreaterThan(10);
  });

  it("skips nested quality evaluation fixtures when building a talk tree", async () => {
    const root = await temporary.create("docsfab-observation-poison-");
    const poison = join(root, "fixture/benchmarks/sample/cases/portable-poison");
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(poison, { recursive: true });
    await writeFile(join(root, "docs", "api.md"), "# API\n\n## Limits\n\nTen requests.\n", "utf8");
    await writeFile(
      join(poison, "index.md"),
      "# Synthetic parser poison\n\n(portable-collision)=\n## First topic\n\n(portable-collision)=\n## Second topic\n",
      "utf8",
    );
    const tree = await buildTalkTree({
      repositoryPath: root,
      repositoryRevision: REVISION,
    });
    expect(tree.pages.map((page) => page.path)).toEqual(["docs/api.md"]);
  });
});

describe("navigation-graph observation probe", () => {
  it("does not invent navigation from ungoverned Markdown presence", async () => {
    const root = await docsRepo();
    const workflow = getWorkflow("update-documentation");
    const step = workflow.steps[0]!;
    const repository = {
      sourcePath: "/selected/source",
      requestedRevision: REVISION,
      revision: REVISION,
    };
    const result = await new LocalWorkflowSearchCoordinator().search({
      runId: "observation-nav-graph",
      repositoryPath: root,
      repository,
      workflow,
      step,
      plan: step.search!,
    });
    const evidence = normalizeWorkflowSearchEvidence({
      plan: step.search!,
      repository,
      repositoryIdentitySha256: result.repositoryIdentitySha256,
      searches: result.searches,
    });
    const nav = evidence.searches
      .flatMap((search) => search.bounded.probes)
      .find((probe) => probe.id === "observation-nav-graph");
    expect(nav?.outcome).toBe("blocked");
    expect(
      evidence.searches
        .flatMap((search) => search.bounded.limitations)
        .some(
          (limitation) =>
            limitation.category === "unsupported-operation" &&
            limitation.probeIds.includes(nav?.id ?? ""),
        ),
    ).toBe(true);
  });
});

describe("knowledge resume", () => {
  function body(
    overrides: Partial<KnowledgeAcceptedSnapshotBodyV1> = {},
  ): KnowledgeAcceptedSnapshotBodyV1 {
    return {
      projectId: "PRJ-001",
      modelVersionId: "MODEL-001",
      streamVersion: 7,
      status: "approved",
      claims: [
        {
          id: "CL-001",
          kind: "intent",
          scope: "Example Product",
          statement: "Approved intent remains attributed.",
          modelState: "canonical",
          evidenceIds: ["SRC-001"],
        },
      ],
      sources: [{ id: "SRC-001", locator: "design" }],
      conflicts: [],
      ...overrides,
    };
  }

  it("continues an accepted snapshot and stops on conflict without inventing intent", () => {
    const accepted = createKnowledgeAcceptedSnapshot(body());
    expect(inspectKnowledgeSnapshotResume(accepted).disposition).toBe("continue");

    const conflicted = createKnowledgeAcceptedSnapshot(
      body({
        claims: [
          {
            id: "CL-001",
            kind: "intent",
            scope: "Example Product",
            statement: "First attributed statement.",
            modelState: "canonical",
            evidenceIds: ["SRC-001"],
          },
          {
            id: "CL-002",
            kind: "intent",
            scope: "Example Product",
            statement: "Conflicting attributed statement.",
            modelState: "disputed",
            evidenceIds: ["SRC-001"],
          },
        ],
        conflicts: [{ id: "CF-001", claimIds: ["CL-001", "CL-002"] }],
      }),
    );
    const inspection = inspectKnowledgeSnapshotResume(conflicted);
    expect(inspection.disposition).toBe("needs-input");
    expect(inspection.stopReason).toBe("conflict");

    expect(() =>
      assertResumeMatchesOriginal({
        workflow: "update-documentation",
        instruction: "Update docs for this API change",
        original: {
          schemaVersion: 1,
          kind: "docsfab-original-task",
          workflow: "create-documentation",
          instructionSha256: instructionSha256("Create a documentation page"),
        },
      }),
    ).toThrow(KnowledgeResumeError);
  });
});
