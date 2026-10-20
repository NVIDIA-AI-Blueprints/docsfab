// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ExecInitCommandRunner } from "../src/init/shared.js";
import type { CommandRunner } from "../src/init/types.js";
import { canonicalGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import {
  GITLAB_SOURCE_PROVIDER_ID,
  type GitLabProjectIdentityPortV1,
  GitLabSourceProviderError,
  gitlabSourceDiscoveryFailureMessage,
  parseGitLabProjectReference,
  resolveGitLabSourceScope,
} from "../src/inputs/gitlab-source-provider.js";
import {
  createGitLabCheckoutIdentityPort,
  createGitLabMergedMrDiffFetcher,
  createGitLabMergedMrPagePort,
  GitLabMergedMrReadError,
} from "../src/inputs/merged-mr-gitlab.js";
import { GITLAB_MERGED_MR_PRODUCER_ID } from "../src/inputs/merged-mr-evidence.js";
import type { MergedMrPagePortV1 } from "../src/inputs/merged-mr-discovery.js";
import {
  resolveMergedMrDateWindow,
  type MergedMrDateWindowV1,
  type MergedMrRecordV1,
} from "../src/inputs/merged-mr-selection.js";
import {
  discoverSourceDescriptors,
  requireLocatorInScope,
  SOURCE_DISCOVERY_REFUSALS,
  SourceDiscoveryError,
  type SourceDiscoveryResultV1,
  type SourceDiscoveryScopeV1,
} from "../src/inputs/source-discovery.js";
import { GITLAB_READ_FAILURES } from "../src/live-agent/gitlab-read.js";
import { temporaryRoots } from "./helpers/temp.js";
import { configureCredential } from "./helpers/configured-credential.js";

const roots = temporaryRoots();

const HOST = "gitlab.example.test";
const PROJECT_ID = 437_040;
const PROJECT_PATH = "team/project";

type FailureCode = keyof typeof GITLAB_READ_FAILURES;

interface FixturePage {
  readonly page: number;
  readonly nextPage: number | null;
  readonly truncated?: boolean;
  readonly failure?: FailureCode;
  readonly items: readonly MergedMrRecordV1[];
}

interface Fixture {
  readonly description: string;
  readonly window: { timeZone: string; startDate: string; endDate: string };
  readonly targetBranch: string;
  readonly pages: readonly FixturePage[];
}

function loadFixture(name: string): Fixture {
  const path = new URL(`./fixtures/merged-mr-update/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function windowOf(fixture: Fixture): MergedMrDateWindowV1 {
  return resolveMergedMrDateWindow(fixture.window);
}

function scopeOf(overrides: Partial<SourceDiscoveryScopeV1> = {}): SourceDiscoveryScopeV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-source-discovery-scope",
    providerId: GITLAB_SOURCE_PROVIDER_ID,
    host: HOST,
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
    ...overrides,
  } as SourceDiscoveryScopeV1;
}

function locatorFor(iid: number, projectId: number = PROJECT_ID, host: string = HOST): string {
  return canonicalGitlabMrReviewLocator({ host, projectId, mergeRequestIid: iid });
}

/**
 * `honourFailures: false` turns the same fixture into the positive control for
 * every failure assertion, so a passing failure test cannot be an artefact of a
 * fixture that would never have produced descriptors anyway.
 */
function portFor(
  fixture: Fixture,
  options: { ordered?: boolean; honourFailures?: boolean; failureCode?: FailureCode } = {},
): MergedMrPagePortV1 {
  return {
    orderedDescendingByMergedAt: options.ordered ?? false,
    async fetchPage(page: number) {
      const entry = fixture.pages.find((candidate) => candidate.page === page);
      if (!entry) throw new Error(`fixture ${fixture.description} has no page ${page}`);
      if (entry.failure && options.honourFailures !== false) {
        const code = options.failureCode ?? entry.failure;
        // The shape a real adapter uses: the shared operator message plus the
        // code the walk is allowed to retain.
        throw Object.assign(new Error(GITLAB_READ_FAILURES[code]), { code });
      }
      return { items: entry.items, nextPage: entry.nextPage, truncated: entry.truncated === true };
    },
  };
}

function discover(
  fixture: Fixture,
  options: {
    ordered?: boolean;
    honourFailures?: boolean;
    failureCode?: FailureCode;
    scope?: SourceDiscoveryScopeV1;
    requestedLocators?: readonly string[];
    presentRevisions?: readonly string[];
    maxDescriptors?: number;
    maxPages?: number;
  } = {},
): Promise<SourceDiscoveryResultV1> {
  return discoverSourceDescriptors({
    scope: options.scope ?? scopeOf(),
    port: portFor(fixture, options),
    window: windowOf(fixture),
    targetBranch: fixture.targetBranch,
    ...(options.requestedLocators ? { requestedLocators: options.requestedLocators } : {}),
    ...(options.presentRevisions ? { presentRevisions: options.presentRevisions } : {}),
    ...(options.maxDescriptors === undefined ? {} : { maxDescriptors: options.maxDescriptors }),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
  });
}

function iids(result: SourceDiscoveryResultV1): number[] {
  return result.descriptors.map((entry) => entry.mergeRequestIid);
}

const discoverySource = readFileSync(
  new URL("../src/inputs/source-discovery.ts", import.meta.url),
  "utf8",
);
const providerSource = readFileSync(
  new URL("../src/inputs/gitlab-source-provider.ts", import.meta.url),
  "utf8",
);

/**
 * Locks the merged-MR GitLab `list_merged` / `diffs` endpoint contract and the
 * checkout identity adapter a GitLab provider consumes.
 */
describe("merged-MR GitLab discovery transport (#896)", () => {
  it("lists merged MRs with merged_at descending pages of 100 and reads per-MR diffs", async () => {
    const root = await roots.create("docsfab-merged-mr-gitlab-");
    execFileSync("git", ["init", "-q", root]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.test/team/project.git"],
      {
        cwd: root,
      },
    );
    const real = new ExecInitCommandRunner();
    const calls: string[] = [];
    const commands: CommandRunner = {
      async run(command, args, cwd, options) {
        if (command === "git") return real.run(command, args, cwd, options);
        calls.push(String(args.at(-1)));
        if (String(args.at(-1)).includes("/diffs")) {
          return {
            stdout: JSON.stringify([
              {
                old_path: "src/orbit.ts",
                new_path: "src/orbit.ts",
                diff: "+export const option = '--new';\n",
                collapsed: false,
                too_large: false,
                new_file: false,
                deleted_file: false,
                renamed_file: false,
              },
            ]),
            exitCode: 0,
          };
        }
        return {
          stdout: JSON.stringify([
            {
              iid: 42,
              title: "Document export",
              state: "merged",
              merged_at: "2026-09-14T18:00:00.000Z",
              target_branch: "main",
              merge_commit_sha: "a".repeat(40),
              squash_commit_sha: null,
            },
          ]),
          exitCode: 0,
        };
      },
    };
    const options = {
      repositoryPath: root,
      commands,
      environment: { PATH: process.env.PATH, HOME: root, GLAB_CONFIG_DIR: join(root, "glab") },
    };
    const page = await createGitLabMergedMrPagePort(options).fetchPage(1);
    expect(page.items).toEqual([
      expect.objectContaining({
        iid: 42,
        mergedAt: "2026-09-14T18:00:00.000Z",
        targetBranch: "main",
      }),
    ]);
    expect(page.nextPage).toBeNull();
    const diffs = await createGitLabMergedMrDiffFetcher(options)(42);
    expect(diffs.files[0]).toMatchObject({ newPath: "src/orbit.ts", collapsed: false });
    expect(diffs.truncated).toBe(false);
    expect(calls).toEqual([
      "projects/team%2Fproject/merge_requests?state=merged&scope=all&order_by=merged_at&sort=desc&per_page=100&page=1",
      "projects/team%2Fproject/merge_requests/42/diffs?per_page=20&page=1",
    ]);
  });

  it("omits list_merged descriptions so a credential-shaped body does not fail the page", async () => {
    const root = await roots.create("docsfab-merged-mr-gitlab-desc-");
    execFileSync("git", ["init", "-q", root]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.test/team/project.git"],
      { cwd: root },
    );
    const real = new ExecInitCommandRunner();
    const shaped = ["gl", "pat", "-", "A1b2C3d4E5f6G7h8I9j0K1"].join("");
    const commands: CommandRunner = {
      async run(command, args, cwd, options) {
        if (command === "git") return real.run(command, args, cwd, options);
        return {
          stdout: JSON.stringify([
            {
              iid: 42,
              title: "Document export",
              description: `Example token ${shaped} in an MR body.`,
              state: "merged",
              merged_at: "2026-09-14T18:00:00.000Z",
              target_branch: "main",
              merge_commit_sha: "a".repeat(40),
              squash_commit_sha: null,
            },
          ]),
          exitCode: 0,
        };
      },
    };
    const page = await createGitLabMergedMrPagePort({
      repositoryPath: root,
      commands,
      environment: { PATH: process.env.PATH, HOME: root, GLAB_CONFIG_DIR: join(root, "glab") },
    }).fetchPage(1);
    expect(page.items).toEqual([
      expect.objectContaining({
        iid: 42,
        title: "Document export",
        mergedAt: "2026-09-14T18:00:00.000Z",
        targetBranch: "main",
      }),
    ]);
    expect(page.items[0]).not.toHaveProperty("description");
  });

  it("omits configured-credential diff files and keeps the rest as truncated evidence", async () => {
    const root = await roots.create("docsfab-merged-mr-gitlab-diff-cred-");
    execFileSync("git", ["init", "-q", root]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.test/team/project.git"],
      { cwd: root },
    );
    const real = new ExecInitCommandRunner();
    // Configured: only a configured credential is withheld (#1807).
    const shaped = configureCredential(["gl", "pat", "-", "A1b2C3d4E5f6G7h8I9j0K1"].join(""));
    const commands: CommandRunner = {
      async run(command, args, cwd, options) {
        if (command === "git") return real.run(command, args, cwd, options);
        return {
          stdout: JSON.stringify([
            {
              old_path: "src/orbit.ts",
              new_path: "src/orbit.ts",
              diff: "+export const option = '--new';\n",
              collapsed: false,
              too_large: false,
              new_file: false,
              deleted_file: false,
              renamed_file: false,
            },
            {
              old_path: "docs/tokens.md",
              new_path: "docs/tokens.md",
              diff: `+Example ${shaped}\n`,
              collapsed: false,
              too_large: false,
              new_file: false,
              deleted_file: false,
              renamed_file: false,
            },
          ]),
          exitCode: 0,
        };
      },
    };
    const diffs = await createGitLabMergedMrDiffFetcher({
      repositoryPath: root,
      commands,
      environment: { PATH: process.env.PATH, HOME: root, GLAB_CONFIG_DIR: join(root, "glab") },
    })(42);
    expect(diffs.files).toEqual([
      expect.objectContaining({ newPath: "src/orbit.ts", collapsed: false }),
    ]);
    expect(diffs.truncated).toBe(true);
  });

  it("does not classify an oversize GitLab page as unreachable because stdout mentioned timeout", async () => {
    const root = await roots.create("docsfab-merged-mr-gitlab-limit-");
    execFileSync("git", ["init", "-q", root]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.test/team/project.git"],
      { cwd: root },
    );
    const real = new ExecInitCommandRunner();
    const commands: CommandRunner = {
      async run(command, args, cwd, options) {
        if (command === "git") return real.run(command, args, cwd, options);
        return {
          exitCode: 1,
          stdout: '[{"title":"fix aggregate timeout"}]',
          stderr: "",
          failure: "output-limit",
        };
      },
    };
    await expect(
      createGitLabMergedMrPagePort({
        repositoryPath: root,
        commands,
        environment: { PATH: process.env.PATH, HOME: root, GLAB_CONFIG_DIR: join(root, "glab") },
      }).fetchPage(1),
    ).rejects.toMatchObject({ name: "GitLabMergedMrReadError", code: "response" });
  });

  it("resolves checkout identity with a required numeric project id for the shared provider", async () => {
    const root = await roots.create("docsfab-merged-mr-identity-");
    execFileSync("git", ["init", "-q", root]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.test/team/project.git"],
      { cwd: root },
    );
    const real = new ExecInitCommandRunner();
    const commands: CommandRunner = {
      async run(command, args, cwd, options) {
        if (command === "git") return real.run(command, args, cwd, options);
        expect(String(args.at(-1))).toBe("projects/team%2Fproject");
        return {
          stdout: JSON.stringify({ id: PROJECT_ID, path_with_namespace: PROJECT_PATH }),
          exitCode: 0,
        };
      },
    };
    const options = {
      repositoryPath: root,
      commands,
      environment: { PATH: process.env.PATH, HOME: root, GLAB_CONFIG_DIR: join(root, "glab") },
    };
    const identity = await createGitLabCheckoutIdentityPort(options).resolveProjectIdentity({
      host: HOST,
      projectPath: PROJECT_PATH,
    });
    expect(identity).toEqual({ host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH });
    const scope = await resolveGitLabSourceScope({
      reference: { host: HOST, projectPath: PROJECT_PATH },
      identityPort: createGitLabCheckoutIdentityPort(options),
    });
    expect(scope).toMatchObject({ host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH });
  });

  it("refuses a checkout whose project API omitted the numeric id", async () => {
    const root = await roots.create("docsfab-merged-mr-identity-missing-");
    execFileSync("git", ["init", "-q", root]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.example.test/team/project.git"],
      { cwd: root },
    );
    const real = new ExecInitCommandRunner();
    const commands: CommandRunner = {
      async run(command, args, cwd, options) {
        if (command === "git") return real.run(command, args, cwd, options);
        return {
          stdout: JSON.stringify({ path_with_namespace: PROJECT_PATH }),
          exitCode: 0,
        };
      },
    };
    await expect(
      createGitLabCheckoutIdentityPort({
        repositoryPath: root,
        commands,
        environment: { PATH: process.env.PATH, HOME: root, GLAB_CONFIG_DIR: join(root, "glab") },
      }).resolveProjectIdentity({ host: HOST, projectPath: PROJECT_PATH }),
    ).rejects.toBeInstanceOf(GitLabMergedMrReadError);
    await expect(
      createGitLabCheckoutIdentityPort({
        repositoryPath: root,
        commands,
        environment: { PATH: process.env.PATH, HOME: root, GLAB_CONFIG_DIR: join(root, "glab") },
      }).resolveProjectIdentity({ host: HOST, projectPath: PROJECT_PATH }),
    ).rejects.toMatchObject({ code: "response" });
  });
});

/**
 * The discovery service over the merged-MR driver, from fixtures only. This
 * does not replace an authenticated live GitLab read and full discovery proof.
 */
describe("source discovery service over the merged-MR driver (#799)", () => {
  it("returns bounded descriptors and a closed cursor for a fully walked window", async () => {
    const result = await discover(loadFixture("ordered-descending"), { ordered: true });
    expect(iids(result)).toEqual([5501, 5503, 5504, 5505]);
    expect(result.coverage.disposition).toBe("complete");
    expect(result.coverage.windowCovered).toBe(true);
    // Page three falls below the window start and page four is the ordering
    // confirmation the driver reads before it trusts the early stop.
    expect(result.cursor).toEqual({ resumable: false, nextPage: null, lastGoodPage: 4 });
    expect(result.descriptors[0]).toMatchObject({
      kind: "docsfab-source-descriptor",
      providerId: GITLAB_SOURCE_PROVIDER_ID,
      locator: locatorFor(5501),
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      mergedAt: "2026-09-14T18:00:00.000Z",
      targetBranch: "main",
      commitProvenance: "merge",
      applicability: "unassessed",
    });
    expect(result.coverage.excluded.map((entry) => entry.reason)).toContain("other-target-branch");
  });

  it("follows the cursor to a merge request that appears only on page two", async () => {
    const result = await discover(loadFixture("page-two-match"));
    // Divergent ids, branches and merge dates on page one: an identity
    // collision cannot fake this pass.
    expect(iids(result)).toEqual([5203]);
    expect(result.descriptors[0]?.locator).toBe(locatorFor(5203));
    expect(result.descriptors[0]?.commitProvenance).toBe("squash");
    expect(result.descriptors[0]?.commitSha).toBe("54a4c3d4e5b6978899aabbccddeeff0011223344");
    expect(result.coverage.pagesRead).toBe(2);
    expect(result.coverage.windowCovered).toBe(true);
  });

  it("reports exhausted-empty for a fully walked window with no matching merges", async () => {
    const result = await discover(loadFixture("no-matching-merges"));
    expect(result.descriptors).toEqual([]);
    expect(result.coverage.disposition).toBe("exhausted-empty");
    // An empty answer here is a statement about the project, and it is
    // reported as covered.
    expect(result.coverage.windowCovered).toBe(true);
    expect(result.coverage.failureCode).toBeNull();
    expect(result.cursor.resumable).toBe(false);
  });

  it("reports page-failed with the last good page when page two errors and never reports complete", async () => {
    const result = await discover(loadFixture("page-two-failure"));
    expect(result.coverage.disposition).toBe("page-failed");
    expect(result.coverage.disposition).not.toBe("complete");
    expect(result.coverage.failureCode).toBe("authentication");
    expect(result.coverage.windowCovered).toBe(false);
    expect(iids(result)).toEqual([9801]);
    expect(result.cursor).toEqual({ resumable: true, nextPage: 2, lastGoodPage: 1 });
  });

  it("reports complete for the same fixture once the injected page-two failure is removed", async () => {
    // Positive control for the failure case above.
    const result = await discover(loadFixture("page-two-failure"), { honourFailures: false });
    expect(result.coverage.disposition).toBe("complete");
    expect(result.coverage.windowCovered).toBe(true);
    expect(result.coverage.failureCode).toBeNull();
    expect(iids(result)).toEqual([9801, 9802]);
  });

  it("retains the GitLab access failure code and leaves the window uncovered", async () => {
    const result = await discover(loadFixture("page-two-failure"), { failureCode: "access" });
    expect(result.coverage.failureCode).toBe("access");
    expect(result.coverage.windowCovered).toBe(false);
    expect(gitlabSourceDiscoveryFailureMessage("access")).toBe(GITLAB_READ_FAILURES.access);
  });

  it("never copies the port's own error text into the discovery result", async () => {
    const sentinel = "port-diagnostic-4f2b-do-not-propagate";
    const result = await discoverSourceDescriptors({
      scope: scopeOf(),
      window: resolveMergedMrDateWindow({
        timeZone: "America/Los_Angeles",
        startDate: "2026-09-14",
        endDate: "2026-09-14",
      }),
      targetBranch: "main",
      port: {
        orderedDescendingByMergedAt: true,
        async fetchPage() {
          throw Object.assign(new Error(sentinel), { code: "network" });
        },
      },
    });
    expect(result.coverage.failureCode).toBe("network");
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("retains server truncation as a per-item evidence gap rather than dropping the item", async () => {
    const result = await discover(loadFixture("truncated-page"));
    expect(iids(result)).toEqual([1901]);
    expect(result.descriptors[0]?.evidenceGaps).toContain("truncated-source-page");
    expect(result.coverage.truncatedPages).toEqual([1]);
  });

  it("passes the duplicate rows of a shifting list through to coverage without double-describing", async () => {
    const result = await discover(loadFixture("shifting-list"));
    expect(iids(result)).toEqual([5001, 5002, 5003, 5004]);
    expect(result.coverage.duplicateRows).toEqual([5002]);
    expect(result.coverage.rowsRead).toBe(5);
    expect(result.coverage.itemsRead).toBe(4);
  });

  it("reports a selected revision absent from the target checkout as inapplicable without substituting a comparison", async () => {
    const result = await discover(loadFixture("squash-and-merge-identity"), {
      // 8701 is present by its squash commit; 8702's merge commit is absent;
      // 8703 has no commit identity at all.
      presentRevisions: ["87b1c3d4e5b6978899aabbccddeeff0011223344"],
    });
    expect(iids(result)).toEqual([8701]);
    expect(result.descriptors[0]?.applicability).toBe("applicable");
    expect(
      result.inapplicable.map((entry) => [entry.mergeRequestIid, entry.applicability]),
    ).toEqual([
      [8702, "revision-absent-from-checkout"],
      [8703, "missing-commit-identity"],
    ]);
  });

  it("leaves applicability unassessed when no checkout revisions are offered", async () => {
    const result = await discover(loadFixture("squash-and-merge-identity"));
    expect(result.descriptors.map((entry) => entry.applicability)).toEqual([
      "unassessed",
      "unassessed",
      "unassessed",
    ]);
    expect(result.inapplicable).toEqual([]);
  });

  it("selects the local-offset and fractional-second timestamps the live API actually returns", async () => {
    const result = await discover(loadFixture("offset-timestamps"));
    expect(iids(result)).toEqual([7701, 7702]);
    expect(result.descriptors[1]?.mergedAt).toBe("2026-11-01T13:22:41.272-07:00");
    const unusable = result.coverage.excluded.filter(
      (entry) => entry.reason === "unusable-merged-at",
    );
    expect(unusable.map((entry) => entry.iid)).toEqual([7705, 7706]);
  });

  it("narrows discovery to the requested locators and records the rest as not requested", async () => {
    const result = await discover(loadFixture("ordered-descending"), {
      ordered: true,
      requestedLocators: [locatorFor(5503), locatorFor(5505)],
    });
    expect(iids(result)).toEqual([5503, 5505]);
    expect(result.coverage.notRequested).toEqual([5501, 5504]);
  });

  it("refuses a locator naming a project outside the enabled scope", async () => {
    const outside = locatorFor(5503, PROJECT_ID + 1);
    await expect(
      discover(loadFixture("ordered-descending"), { requestedLocators: [outside] }),
    ).rejects.toMatchObject({
      name: "SourceDiscoveryError",
      code: "out-of-scope-locator",
      message: SOURCE_DISCOVERY_REFUSALS["out-of-scope-locator"],
    });
  });

  it("refuses a locator naming another host under the same project number", async () => {
    const elsewhere = locatorFor(5503, PROJECT_ID, "gitlab.other.test");
    await expect(
      discover(loadFixture("ordered-descending"), { requestedLocators: [elsewhere] }),
    ).rejects.toMatchObject({ code: "out-of-scope-locator" });
  });

  it("refuses a local filesystem path presented as a remote locator", () => {
    for (const path of ["/tmp/evidence/mr.json", "./mr.json", "../../etc/hosts", "file:///tmp/x"]) {
      expect(() => requireLocatorInScope(path, scopeOf())).toThrow(
        SOURCE_DISCOVERY_REFUSALS["local-path"],
      );
    }
  });

  it("refuses source text and a provider endpoint presented as a locator", () => {
    for (const text of [
      "https://gitlab.example.test/api/v4/projects/1/merge_requests",
      "gitlab-mr:v2:host=gitlab.example.test:project=437040:mr=5503",
      "please read merge request 5503",
      "gitlab-mr:v1:host=gitlab.example.test:project=0437040:mr=5503",
    ]) {
      expect(() => requireLocatorInScope(text, scopeOf())).toThrow(
        SOURCE_DISCOVERY_REFUSALS["unsupported-locator"],
      );
    }
  });

  it("never echoes the refused locator text in its refusal message", () => {
    const sentinel = "gitlab-mr:v1:host=gitlab.example.test:project=99:mr=41616161";
    try {
      requireLocatorInScope(sentinel, scopeOf());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceDiscoveryError);
      expect((error as Error).message).not.toContain("41616161");
      expect((error as Error).message).not.toContain("project=99");
    }
  });

  it("refuses to describe anything when the scope carries a project path but no numeric id", async () => {
    const pathOnly = scopeOf({ projectId: undefined as unknown as number });
    await expect(
      discover(loadFixture("page-two-match"), { scope: pathOnly }),
    ).rejects.toMatchObject({
      code: "scope-identity",
      message: SOURCE_DISCOVERY_REFUSALS["scope-identity"],
    });
  });

  it("bounds returned descriptors at the configured ceiling and reports the window as uncovered", async () => {
    const result = await discover(loadFixture("ordered-descending"), {
      ordered: true,
      maxDescriptors: 2,
    });
    expect(iids(result)).toEqual([5501, 5503]);
    expect(result.coverage.descriptorLimitReached).toBe(true);
    expect(result.coverage.disposition).toBe("complete");
    // A capped answer is not a covered window, however clean the walk was.
    expect(result.coverage.windowCovered).toBe(false);
  });

  it("reports a covered window at exactly the descriptor ceiling", async () => {
    // Boundary positive control for the cap above.
    const result = await discover(loadFixture("ordered-descending"), {
      ordered: true,
      maxDescriptors: 4,
    });
    expect(iids(result)).toEqual([5501, 5503, 5504, 5505]);
    expect(result.coverage.descriptorLimitReached).toBe(false);
    expect(result.coverage.windowCovered).toBe(true);
  });

  it("refuses to return a result carrying configured-credential row text", async () => {
    // Assembled from parts so the literal never exists in this file's bytes.
    // Configured: only a configured credential is refused (#1807).
    const shaped = configureCredential(["gl", "pat", "-", "A1b2C3d4E5f6G7h8I9j0K1"].join(""));
    const row: MergedMrRecordV1 = {
      iid: 6101,
      state: "merged",
      mergedAt: "2026-09-14T18:00:00.000Z",
      targetBranch: shaped,
      mergeCommitSha: "61a1c3d4e5b6978899aabbccddeeff0011223344",
      squashCommitSha: null,
    };
    const port: MergedMrPagePortV1 = {
      orderedDescendingByMergedAt: true,
      async fetchPage() {
        return { items: [row], nextPage: null };
      },
    };
    const request = {
      scope: scopeOf(),
      port,
      window: resolveMergedMrDateWindow({
        timeZone: "America/Los_Angeles",
        startDate: "2026-09-14",
        endDate: "2026-09-14",
      }),
      targetBranch: "main",
    };
    await expect(discoverSourceDescriptors(request)).rejects.toMatchObject({
      name: "SourceDiscoveryError",
      code: "credentials",
    });
    // Positive control: the same row with an ordinary branch name is described.
    const clean = await discoverSourceDescriptors({
      ...request,
      port: {
        orderedDescendingByMergedAt: true,
        async fetchPage() {
          return { items: [{ ...row, targetBranch: "main" }], nextPage: null };
        },
      },
    });
    expect(iids(clean)).toEqual([6101]);
  });

  it("carries no merge-request title or description bytes in any descriptor", async () => {
    const fixture = loadFixture("page-two-match");
    const result = await discover(fixture);
    // The described row is 5203, so its own text is what has to be absent;
    // asserting against another row's words would pass for free.
    const described = fixture.pages.flatMap((page) => page.items).find((item) => item.iid === 5203);
    expect(described?.title).toBe("Document the new profile inspect output");
    const serialized = JSON.stringify(result.descriptors);
    for (const phrase of [
      described?.title,
      described?.description,
      described?.sourceBranch,
      described?.url,
    ]) {
      expect(typeof phrase).toBe("string");
      expect(serialized).not.toContain(phrase as string);
    }
    // Stronger than an absence list: the descriptor's whole key set is fixed,
    // so a future field carrying evidence text fails here rather than silently
    // widening what a descriptor exposes.
    expect(Object.keys(result.descriptors[0] ?? {}).sort()).toEqual([
      "applicability",
      "commitProvenance",
      "commitSha",
      "evidenceGaps",
      "kind",
      "locator",
      "mergeRequestIid",
      "mergedAt",
      "mergedAtMs",
      "projectId",
      "projectPath",
      "providerId",
      "schemaVersion",
      "targetBranch",
    ]);
  });

  it("opens no transport of its own in either discovery module", () => {
    // A source-level check over direct escapes only: the shipped `glab`
    // transport is merged-mr-gitlab.ts and neither module reaches it, so every
    // page arrives through the injected port. It does not prove the transitive
    // closure is inert; the credential scanner reached through
    // ./credential-isolation.js is pure over the string it is handed. The
    // escape list mirrors test/source-evidence-pdf.test.ts's wrapper set.
    for (const source of [discoverySource, providerSource]) {
      expect(source).not.toMatch(
        /from "node:(?:fs|fs\/promises|child_process|net|http|https|dns|os|vm|process|worker_threads)/u,
      );
      expect(source).not.toMatch(/from "\.\/merged-mr-gitlab\.js"/u);
      expect(source).not.toMatch(/\bgetBuiltinModule\b/u);
      expect(source).not.toMatch(/\bcreateRequire\b/u);
      expect(source).not.toMatch(/(?<![.\w])require\s*\(/u);
      expect(source).not.toMatch(/(?<![.\w])import\s*\(/u);
      expect(source).not.toMatch(/\bfetch\s*\(/u);
      expect(source).not.toMatch(/\bprocess\.(?:env|cwd|binding)\b/u);
      expect(source).not.toContain("Date.now(");
    }
  });
});

describe("GitLab source provider boundary (#799)", () => {
  it("names the same provider identity the merged-MR acquisition producer uses", () => {
    expect(GITLAB_SOURCE_PROVIDER_ID).toBe(GITLAB_MERGED_MR_PRODUCER_ID);
  });

  it("treats a reference carrying the numeric project id as canonical and reads nothing", async () => {
    let called = 0;
    const scope = await resolveGitLabSourceScope({
      reference: { host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH },
      identityPort: {
        async resolveProjectIdentity() {
          called += 1;
          return { host: HOST, projectId: 1, projectPath: PROJECT_PATH };
        },
      },
    });
    expect(called).toBe(0);
    expect(scope).toMatchObject({ projectId: PROJECT_ID, projectPath: PROJECT_PATH });
  });

  it("resolves a project path once at the boundary and records both the id and the path", async () => {
    const seen: unknown[] = [];
    const scope = await resolveGitLabSourceScope({
      reference: { host: HOST, projectPath: PROJECT_PATH },
      identityPort: {
        async resolveProjectIdentity(reference) {
          seen.push(reference);
          return { host: HOST, projectId: PROJECT_ID, projectPath: PROJECT_PATH };
        },
      },
    });
    expect(seen).toEqual([{ host: HOST, projectPath: PROJECT_PATH }]);
    expect(scope.projectId).toBe(PROJECT_ID);
    expect(scope.projectPath).toBe(PROJECT_PATH);
    // The canonical locator is keyed on the id the boundary just recorded.
    expect(locatorFor(5203)).toContain(`project=${PROJECT_ID}`);
  });

  it("refuses a path-only reference when no identity port is offered", async () => {
    await expect(
      resolveGitLabSourceScope({ reference: { host: HOST, projectPath: PROJECT_PATH } }),
    ).rejects.toMatchObject({ code: "scope-identity" });
  });

  /**
   * A port is external code, so each of these answers violates the declared
   * return type on purpose: the type is the contract and the runtime guard is
   * the enforcement. `resolveProjectIdentity` is cast rather than typed so the
   * violation is explicit at the call site.
   */
  function portAnswering(answer: unknown): GitLabProjectIdentityPortV1 {
    return {
      async resolveProjectIdentity() {
        return answer;
      },
    } as unknown as GitLabProjectIdentityPortV1;
  }

  it("refuses a resolution whose port returned no usable numeric id", async () => {
    await expect(
      resolveGitLabSourceScope({
        reference: { host: HOST, projectPath: PROJECT_PATH },
        identityPort: portAnswering({ host: HOST, projectPath: PROJECT_PATH }),
      }),
    ).rejects.toMatchObject({ code: "scope-identity" });
  });

  it("refuses a resolution whose port answered about a different project", async () => {
    await expect(
      resolveGitLabSourceScope({
        reference: { host: HOST, projectPath: PROJECT_PATH },
        identityPort: portAnswering({ host: HOST, projectId: 99, projectPath: "other/project" }),
      }),
    ).rejects.toMatchObject({ code: "out-of-scope-locator" });
  });

  it("refuses a resolution whose port omitted the project path it answered about", async () => {
    // The dangerous shape: an unconfirmed answer whose id would still become
    // the key every later locator is minted from.
    await expect(
      resolveGitLabSourceScope({
        reference: { host: HOST, projectPath: PROJECT_PATH },
        identityPort: portAnswering({ host: HOST, projectId: 99 }),
      }),
    ).rejects.toMatchObject({ code: "out-of-scope-locator" });
  });

  it("refuses a resolution whose port answered about the same path on another host", async () => {
    await expect(
      resolveGitLabSourceScope({
        reference: { host: HOST, projectPath: PROJECT_PATH },
        identityPort: portAnswering({
          host: "gitlab.other.test",
          projectId: 99,
          projectPath: PROJECT_PATH,
        }),
      }),
    ).rejects.toMatchObject({ code: "out-of-scope-locator" });
  });

  it("refuses a resolution whose port omitted the host it answered about", async () => {
    await expect(
      resolveGitLabSourceScope({
        reference: { host: HOST, projectPath: PROJECT_PATH },
        identityPort: portAnswering({ projectId: 99, projectPath: PROJECT_PATH }),
      }),
    ).rejects.toMatchObject({ code: "out-of-scope-locator" });
  });

  it("maps an identity-port rejection onto a shared failure code without its message", async () => {
    const sentinel = "identity-port-diagnostic-9c31-do-not-propagate";
    const failure = await resolveGitLabSourceScope({
      reference: { host: HOST, projectPath: PROJECT_PATH },
      identityPort: {
        async resolveProjectIdentity() {
          throw Object.assign(new Error(sentinel), { code: "access" });
        },
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitLabSourceProviderError);
    expect((failure as GitLabSourceProviderError).code).toBe("access");
    expect((failure as Error).message).toBe(GITLAB_READ_FAILURES.access);
    expect((failure as Error).message).not.toContain(sentinel);
  });

  it("records an untagged identity-port rejection as the shared request code", async () => {
    const failure = await resolveGitLabSourceScope({
      reference: { host: HOST, projectPath: PROJECT_PATH },
      identityPort: {
        async resolveProjectIdentity() {
          throw new Error("ECONNREFUSED 127.0.0.1:443");
        },
      },
    }).catch((error: unknown) => error);
    expect((failure as GitLabSourceProviderError).code).toBe("request");
    expect((failure as Error).message).toBe(GITLAB_READ_FAILURES.request);
  });

  it("refuses a host filesystem path or credential-bearing URL offered as a project path", () => {
    for (const path of [
      "/srv/repos/project",
      "./project",
      "../project",
      "file:///srv/project",
      "https://gitlab.example.test/team/project",
      "team/../../etc",
      "team",
    ]) {
      expect(() => parseGitLabProjectReference({ host: HOST, projectPath: path })).toThrow(
        SourceDiscoveryError,
      );
    }
    // Positive control: an ordinary nested namespace path parses.
    expect(
      parseGitLabProjectReference({ host: HOST, projectPath: "tech-docs/agents/docsfab" }).kind,
    ).toBe("project-path");
  });

  it("refuses a reference carrying an unknown field or no identity at all", () => {
    expect(() =>
      parseGitLabProjectReference({ host: HOST, projectId: PROJECT_ID, token: "x" }),
    ).toThrow(SOURCE_DISCOVERY_REFUSALS["unsupported-locator"]);
    expect(() => parseGitLabProjectReference({ host: HOST })).toThrow(
      SOURCE_DISCOVERY_REFUSALS["unsupported-locator"],
    );
    expect(() => parseGitLabProjectReference({ host: HOST, projectId: 0 })).toThrow(
      SOURCE_DISCOVERY_REFUSALS["scope-identity"],
    );
  });

  it("refuses to render an operator message for a code outside the shared vocabulary", () => {
    expect(() => gitlabSourceDiscoveryFailureMessage("teapot" as unknown as "access")).toThrow(
      /shared merged-MR failure codes/u,
    );
  });
});
