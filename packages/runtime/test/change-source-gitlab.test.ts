// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The GitLab merge request change source, local arm: one recorded `get`
 * answer through the `glab` command seam pins the commits, and the diff is
 * read from local fixture repositories. Where the checkout lacks an object,
 * the stand-in fails every GitLab diff read, so the local refusal stands; the
 * forge arm itself is `change-source-gitlab-forge.test.ts`.
 */
import { readFileSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCliChangeSource } from "../src/cli/run/source-acquisition.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { OperationalLimitError, limit } from "../src/config/limits.js";
import type { CommandRunner } from "../src/init/types.js";
import { ChangeRequestSelectorError } from "../src/inputs/change-request-selector.js";
import {
  CHANGE_SOURCE_REFUSALS,
  ChangeSourceContractError,
  ChangeSourceError,
  createChangeSource,
  decodeChangeSourceV1,
  parseChangeSourceSelector,
  type ChangeSourceV1,
  type GitLabMergeRequestSelectorV1,
  type GitLabMergeRequestSourceV1,
} from "../src/inputs/change-source.js";
import {
  CHANGE_SOURCE_PRODUCER_IDS,
  changeSourceProducerId,
} from "../src/inputs/change-source/acquisition.js";
import { resolveGitLabMergeRequestChangeSource } from "../src/inputs/change-source/gitlab.js";
import { gitlabProjectIdentity } from "../src/inputs/change-source/revision.js";
import { GitLabSourceProviderError } from "../src/inputs/gitlab-source-provider.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  commitFiles,
  fixtureGit,
  initChangeRepository,
  rewriteLooseObject,
} from "./support/change-source-fixture.js";

const HOST = "gitlab.example.test";
const PROJECT_PATH = "team/docs-project";
const PROJECT_ID = 4242;
const IID = 813;
const MR_URL = `https://${HOST}/${PROJECT_PATH}/-/merge_requests/${IID}`;
const MR_ENDPOINT = `projects/${encodeURIComponent(PROJECT_PATH)}/merge_requests/${IID}`;

const roots = temporaryRoots();
const overrides: string[] = [];

function override(variable: string, value: number): void {
  overrides.push(variable);
  process.env[variable] = String(value);
}

afterEach(() => {
  for (const variable of overrides.splice(0)) delete process.env[variable];
});

/** The recorded GitLab 17.7 `get` answer, with its commit ids filled from the fixture. */
const RECORDED = readFileSync(
  join(import.meta.dirname, "fixtures", "change-source-gitlab", "merge-request-get.json"),
  "utf8",
);

function recordedMergeRequest(
  ids: Readonly<Record<"base" | "start" | "head" | "merge", string | null>>,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const filled = JSON.parse(RECORDED, (_key, value: unknown) =>
    typeof value === "string" && value.startsWith("@")
      ? ids[value.slice(1) as keyof typeof ids]
      : value,
  ) as Record<string, unknown>;
  return { ...filled, ...fields };
}

interface ForgeCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** An answer the stand-in turns into a failed `glab` call, as an expired login fails. */
const LOGIN_EXPIRED = Symbol("glab login expired");

/** A `glab` stand-in answering every merge request read from `answer`, recording each call. */
function forge(answer: (endpoint: string) => unknown) {
  const calls: ForgeCall[] = [];
  const commands: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      const endpoint = String(args.at(-1));
      const body = answer(endpoint);
      return body === LOGIN_EXPIRED
        ? { stdout: "", stderr: "glab: 401 Unauthorized", exitCode: 1 }
        : { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
    },
  };
  return { calls, access: { commands, environment: {} } };
}

/** Answers the pin `get` only; every GitLab diff read fails, so a local refusal stands. */
function pinOnly(body: Record<string, unknown>) {
  return forge((endpoint) => (endpoint === MR_ENDPOINT ? body : LOGIN_EXPIRED));
}

/** The detail a local refusal carries once the GitLab read failed too. */
function bothFailed(local: string): string {
  return `${local}; GitLab read failed: authentication`;
}

/**
 * `main` at `base`; `feature` adds two commits; `main` then takes them through
 * a merge commit, and `squashed` takes them as one squash commit.
 */
async function mergeRequestRepository() {
  const { repository } = await initChangeRepository(
    await roots.create("docsfab-change-source-gitlab-"),
    { "README.md": "# Fixture\n", "docs/guide.md": "one\ntwo\n" },
  );
  const base = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["checkout", "-q", "-b", "feature"]);
  const first = await commitFiles(repository, { "docs/guide.md": "one\nTWO\n" }, "Edit the guide");
  const second = await commitFiles(repository, { "docs/new.md": "new page\n" }, "Add a page");
  await fixtureGit(repository, ["checkout", "-q", "-b", "squashed", base]);
  await fixtureGit(repository, ["merge", "-q", "--squash", "feature"]);
  await fixtureGit(repository, ["commit", "-q", "-m", "Require an explicit export path"]);
  const squash = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["checkout", "-q", "main"]);
  await fixtureGit(repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'feature' into 'main'",
    "feature",
  ]);
  const merge = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  return { repository, base, first, second, squash, merge };
}

async function resolveMergeRequest(
  repository: string,
  access: ReturnType<typeof forge>["access"],
  extra: {
    readonly selector?: string;
    readonly observeGit?: (args: readonly string[]) => void;
    readonly onStatus?: (message: string) => void;
  } = {},
) {
  return resolveGitLabMergeRequestChangeSource({
    selector: parseChangeSourceSelector(extra.selector ?? MR_URL) as GitLabMergeRequestSelectorV1,
    sourcePath: repository,
    repositoryPath: repository,
    workspaceRevision: await fixtureGit(repository, ["rev-parse", "HEAD"]),
    forge: access,
    ...(extra.observeGit ? { observeGit: extra.observeGit } : {}),
    ...(extra.onStatus ? { onStatus: extra.onStatus } : {}),
  });
}

function sourceOf(changeSource: ChangeSourceV1): GitLabMergeRequestSourceV1 {
  expect(changeSource.source.kind).toBe("gitlab-merge-request");
  return changeSource.source as GitLabMergeRequestSourceV1;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return (error as { code?: string } | undefined)?.code;
}

/** A `--no-checkout` partial clone of `repository` under `filter`, holding no checked-out objects. */
async function partialClone(
  repository: string,
  filter: "blob:none" | "tree:0",
  onlyBranch?: string,
): Promise<string> {
  await fixtureGit(repository, ["config", "uploadpack.allowFilter", "true"]);
  const clone = join(await roots.create("docsfab-change-source-gitlab-partial-"), "clone");
  await fixtureGit(repository, [
    "clone",
    "-q",
    `--filter=${filter}`,
    "--no-checkout",
    ...(onlyBranch ? ["--single-branch", "-b", onlyBranch] : []),
    `file://${repository}`,
    clone,
  ]);
  return clone;
}

async function blob(repository: string, revision: string, path: string): Promise<string> {
  return fixtureGit(repository, ["rev-parse", `${revision}:${path}`]);
}

describe("a merged GitLab merge request, local-verified", () => {
  it(
    "pins the merge commit and diffs it against its first parent, from local objects",
    async () => {
      const ids = await mergeRequestRepository();
      const { calls, access } = forge(() =>
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const resolved = await resolveMergeRequest(ids.repository, access);
      const { changeSource } = resolved;

      expect(sourceOf(changeSource)).toEqual({
        kind: "gitlab-merge-request",
        provenance: "local-verified",
        host: HOST,
        projectPath: PROJECT_PATH,
        projectId: PROJECT_ID,
        iid: IID,
        state: "merged",
        mergeMode: "merge-commit",
        diffRefs: { base: ids.base, start: ids.base, head: ids.second },
        mergeCommit: ids.merge,
        squashCommit: null,
        fork: false,
      });
      // Identity follows the kind: the target project, never the checkout path.
      expect(changeSource.revision.repository).toEqual(
        gitlabProjectIdentity({ host: HOST, projectId: PROJECT_ID }),
      );
      expect(changeSource.rangeSemantics).toBe("first-parent-commit");
      expect(changeSource.revision).toMatchObject({ base: ids.base, head: ids.merge });
      expect(changeSource.commits).toEqual([
        {
          id: ids.merge,
          parents: [ids.base, ids.second],
          subject: "Merge branch 'feature' into 'main'",
        },
      ]);
      expect(changeSource.labels).toEqual([]);
      const guideOld = await blob(ids.repository, ids.base, "docs/guide.md");
      const guideNew = await blob(ids.repository, ids.merge, "docs/guide.md");
      const page = await blob(ids.repository, ids.merge, "docs/new.md");
      const zero = "0".repeat(40);
      expect(Buffer.from(resolved.diffBytes).toString("utf8")).toBe(
        [
          "diff --git a/docs/guide.md b/docs/guide.md",
          `index ${guideOld}..${guideNew} 100644`,
          "--- a/docs/guide.md",
          "+++ b/docs/guide.md",
          "@@ -1,2 +1,2 @@",
          " one",
          "-two",
          "+TWO",
          "diff --git a/docs/new.md b/docs/new.md",
          "new file mode 100644",
          `index ${zero}..${page}`,
          "--- /dev/null",
          "+++ b/docs/new.md",
          "@@ -0,0 +1 @@",
          "+new page",
          "",
        ].join("\n"),
      );
      // The sealed manifest is the record, and it decodes under the shipped codec.
      const manifest = JSON.parse(Buffer.from(resolved.manifestBytes).toString("utf8"));
      expect(decodeChangeSourceV1(manifest)).toEqual(changeSource);
      expect(changeSourceProducerId(changeSource)).toBe("change-source-gitlab-local");
      expect(CHANGE_SOURCE_PRODUCER_IDS["local-range"]).toBe("change-source-local");
      // One read, a GET of the merge request itself, on the selector's host.
      expect(calls).toEqual([
        {
          command: "glab",
          args: ["api", "--hostname", HOST, "--method", "GET", MR_ENDPOINT],
        },
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "pins a squash commit as the change, not the branch's own commits",
    async () => {
      const ids = await mergeRequestRepository();
      const { access } = forge(() =>
        recordedMergeRequest(
          { base: ids.base, start: ids.base, head: ids.second, merge: null },
          { squash_commit_sha: ids.squash, squash: true },
        ),
      );
      const { changeSource } = await resolveMergeRequest(ids.repository, access);
      expect(sourceOf(changeSource)).toMatchObject({
        mergeMode: "squash",
        mergeCommit: null,
        squashCommit: ids.squash,
      });
      expect(changeSource.rangeSemantics).toBe("first-parent-commit");
      expect(changeSource.revision).toMatchObject({ base: ids.base, head: ids.squash });
      expect(changeSource.commits.map((commit) => commit.id)).toEqual([ids.squash]);
      expect(changeSource.files.map((file) => [file.status, file.newPath])).toEqual([
        ["M", "docs/guide.md"],
        ["A", "docs/new.md"],
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "prefers the merge commit when a squashed merge request also has one, and records both",
    async () => {
      const ids = await mergeRequestRepository();
      const { access } = forge(() =>
        recordedMergeRequest(
          { base: ids.base, start: ids.base, head: ids.second, merge: ids.merge },
          { squash_commit_sha: ids.squash, squash: true },
        ),
      );
      const { changeSource } = await resolveMergeRequest(ids.repository, access);
      expect(sourceOf(changeSource)).toMatchObject({
        mergeMode: "merge-commit",
        mergeCommit: ids.merge,
        squashCommit: ids.squash,
      });
      expect(changeSource.revision.head).toBe(ids.merge);
    },
    testTimeoutMs(60_000),
  );

  it(
    "diffs a fast-forward merge, which adds no commit, from base to head",
    async () => {
      const ids = await mergeRequestRepository();
      const { access } = forge(() =>
        recordedMergeRequest({ base: ids.base, start: ids.base, head: ids.second, merge: null }),
      );
      const { changeSource } = await resolveMergeRequest(ids.repository, access);
      expect(sourceOf(changeSource)).toMatchObject({ mergeMode: "fast-forward" });
      expect(changeSource.rangeSemantics).toBe("two-dot");
      expect(changeSource.commits.map((commit) => commit.id)).toEqual([ids.first, ids.second]);
      expect(changeSource.labels).toEqual([]);
    },
    testTimeoutMs(60_000),
  );
});

describe("the merge request source member decodes closed and consistent", () => {
  it(
    "refuses a member whose state, merge mode and commits disagree, or whose provenance disagrees with its body",
    async () => {
      const ids = await mergeRequestRepository();
      const { access } = forge(() =>
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const { changeSource } = await resolveMergeRequest(ids.repository, access);
      const { schemaVersion, kind, changeSourceSha256, ...body } = changeSource;
      expect([schemaVersion, kind, changeSourceSha256.length]).toEqual([
        1,
        "docsfab-change-source",
        64,
      ]);
      const member = sourceOf(changeSource);
      const seal = (source: Record<string, unknown>) =>
        createChangeSource({ ...body, source: source as unknown as GitLabMergeRequestSourceV1 });
      const refused = (source: Record<string, unknown>) => {
        try {
          seal(source);
        } catch (error) {
          return (error as ChangeSourceContractError).code;
        }
        return "admitted";
      };
      expect(refused({ ...member })).toBe("admitted");
      // Adjacent: a merge commit beside a recorded squash commit is one landing.
      expect(refused({ ...member, squashCommit: ids.squash })).toBe("admitted");
      for (const [label, source] of [
        ["open with a merge commit", { ...member, state: "opened", mergeMode: null }],
        ["merge mode without its commit", { ...member, mergeCommit: null }],
        [
          "squash mode with a merge commit",
          { ...member, mergeMode: "squash", squashCommit: ids.squash },
        ],
        ["fast-forward with a commit", { ...member, mergeMode: "fast-forward" }],
        ["merged with no merge mode", { ...member, mergeMode: null }],
        ["a zero project id", { ...member, projectId: 0 }],
        ["a string fork flag", { ...member, fork: "false" }],
        ["a short diff ref", { ...member, diffRefs: { ...member.diffRefs, head: "abc" } }],
      ] as const) {
        expect(refused(source as Record<string, unknown>), label).toBe(
          "change-source-contract-invalid-value",
        );
      }
      expect(refused({ ...member, title: "text" })).toBe("change-source-contract-invalid-shape");
      // A forge-reported member over a body with the local diff protocol refuses on the protocol's keys.
      expect(refused({ ...member, provenance: "forge-reported" })).toBe(
        "change-source-contract-invalid-shape",
      );
      expect(refused({ ...member, provenance: "copied" })).toBe(
        "change-source-contract-invalid-value",
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("an open GitLab merge request", () => {
  it(
    "admits base to head, labelled unmerged, and says why its text is not bound",
    async () => {
      const ids = await mergeRequestRepository();
      const { access } = forge(() =>
        recordedMergeRequest(
          { base: ids.base, start: ids.base, head: ids.second, merge: null },
          { state: "opened", merged_at: null, draft: true },
        ),
      );
      const status: string[] = [];
      const { changeSource } = await resolveMergeRequest(ids.repository, access, {
        onStatus: (message) => status.push(message),
      });
      expect(sourceOf(changeSource)).toMatchObject({
        state: "opened",
        mergeMode: null,
        mergeCommit: null,
        squashCommit: null,
      });
      expect(changeSource.rangeSemantics).toBe("two-dot");
      expect(changeSource.revision).toMatchObject({ base: ids.base, head: ids.second });
      expect(changeSource.commits.map((commit) => commit.id)).toEqual([ids.first, ids.second]);
      expect(changeSource.labels).toContain("merge-request-unmerged");
      expect(status).toEqual([
        `change source: merge request !${IID} is open; its description was not bound, because an open merge request's text can still change`,
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "keeps the unmerged label off a merged request of the same range",
    async () => {
      const ids = await mergeRequestRepository();
      const { access } = forge(() =>
        recordedMergeRequest({ base: ids.base, start: ids.base, head: ids.second, merge: null }),
      );
      const status: string[] = [];
      const { changeSource } = await resolveMergeRequest(ids.repository, access, {
        onStatus: (message) => status.push(message),
      });
      expect(changeSource.labels).not.toContain("merge-request-unmerged");
      expect(status).toEqual([]);
    },
    testTimeoutMs(60_000),
  );
});

describe("merge request states and answers that refuse before any object is read", () => {
  it(
    "refuses closed, locked, absent diff refs, and a head that disagrees with its diff, each coded",
    async () => {
      const ids = await mergeRequestRepository();
      const pinned = { base: ids.base, start: ids.base, head: ids.second, merge: ids.merge };
      const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
        [{ state: "closed", merge_commit_sha: null }, "change-source-mr-closed-unmerged"],
        [{ state: "locked" }, "change-source-mr-locked"],
        [{ diff_refs: null }, "change-source-mr-diff-refs-missing"],
        [{ sha: ids.first }, "change-source-mr-moved"],
        // An unknown state is an invalid answer, not a state this kind decides.
        [{ state: "reopened" }, "response"],
        // An answer about another merge request or project is invalid too.
        [{ iid: IID + 1 }, "response"],
        [{ references: { full: `team/other-project!${IID}` } }, "response"],
        [{ project_id: PROJECT_ID + 1 }, "response"],
      ];
      for (const [answer, code] of cases) {
        const { access } = forge(() => recordedMergeRequest(pinned, answer));
        const git: string[][] = [];
        const error = await resolveMergeRequest(ids.repository, access, {
          observeGit: (args) => git.push([...args]),
        }).catch((caught: unknown) => caught);
        expect((error as { code?: string }).code, JSON.stringify(answer)).toBe(code);
        expect(
          error instanceof ChangeSourceError || error instanceof GitLabSourceProviderError,
        ).toBe(true);
        expect(git, JSON.stringify(answer)).toEqual([]);
      }
      // Adjacent: the same answer, merged and consistent, admits.
      const { access } = forge(() => recordedMergeRequest(pinned));
      expect(sourceOf((await resolveMergeRequest(ids.repository, access)).changeSource).state).toBe(
        "merged",
      );
    },
    testTimeoutMs(60_000),
  );

  it("names the refusal and its action without echoing the operator's value", () => {
    for (const code of [
      "change-source-mr-objects-unavailable",
      "change-source-mr-closed-unmerged",
      "change-source-mr-locked",
      "change-source-mr-diff-refs-missing",
      "change-source-mr-moved",
    ] as const) {
      const message = CHANGE_SOURCE_REFUSALS[code];
      expect(message, code).not.toContain(PROJECT_PATH);
      expect(message.split(". ").length, code).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("routing: local objects, else GitLab's diff, else a coded refusal, never a fetch", () => {
  it(
    "refuses a pinned commit this checkout lacks as unavailable objects, reading nothing else",
    async () => {
      const ids = await mergeRequestRepository();
      const absent = "e".repeat(40);
      const { access } = pinOnly(
        recordedMergeRequest({ base: ids.base, start: ids.base, head: ids.second, merge: absent }),
      );
      const git: string[][] = [];
      const error = await resolveMergeRequest(ids.repository, access, {
        observeGit: (args) => git.push([...args]),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(bothFailed("merge commit"));
      // Not a partial clone, so only the commit lookup reads objects.
      expect(git.map((args) => args[0])).toEqual(["config", "cat-file"]);
      expect(git.flat()).not.toContain("fetch");
    },
    testTimeoutMs(60_000),
  );

  it(
    "routes a blobless partial clone away from the local arm, and admits it once the blobs are local",
    async () => {
      const ids = await mergeRequestRepository();
      const clone = await partialClone(ids.repository, "blob:none");
      const { access } = pinOnly(
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const git: string[][] = [];
      const error = await resolveMergeRequest(clone, access, {
        observeGit: (args) => git.push([...args]),
      }).catch((caught: unknown) => caught);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(
        bothFailed(`file blob in a partial clone; sides ${ids.base} then ${ids.merge}`),
      );
      expect(git.flat()).not.toContain("fetch");
      // Holding only the new side's blobs is still a partial read, and refuses.
      await fixtureGit(clone, ["checkout", "-q", ids.merge]);
      const partial = await resolveMergeRequest(clone, access).catch((caught: unknown) => caught);
      expect((partial as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      // Adjacent: the same partial clone holding both sides' blobs is local.
      await fixtureGit(clone, ["checkout", "-q", ids.base]);
      await fixtureGit(clone, ["checkout", "-q", ids.merge]);
      const { changeSource } = await resolveMergeRequest(clone, access);
      expect(changeSource.revision.head).toBe(ids.merge);
    },
    testTimeoutMs(60_000),
  );

  it(
    "routes a treeless partial clone away from the local arm on every git version, and admits it once the trees and blobs are local",
    async () => {
      const ids = await mergeRequestRepository();
      const clone = await partialClone(ids.repository, "tree:0");
      const { access } = pinOnly(
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const git: string[][] = [];
      const error = await resolveMergeRequest(clone, access, {
        observeGit: (args) => git.push([...args]),
      }).catch((caught: unknown) => caught);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(
        bothFailed(`tree in a partial clone; sides ${ids.base} then ${ids.merge}`),
      );
      // The diff that would need the missing trees never runs.
      expect(git.map((args) => args[0])).not.toContain("diff-tree");
      expect(git.flat()).not.toContain("fetch");
      // The merge commit's trees alone are not enough: its first parent's are compared too.
      await fixtureGit(clone, ["checkout", "-q", ids.merge]);
      const parentless = await resolveMergeRequest(clone, access).catch(
        (caught: unknown) => caught,
      );
      expect((parentless as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((parentless as ChangeSourceError).detail).toBe(
        bothFailed(`tree in a partial clone; sides ${ids.base} then ${ids.merge}`),
      );
      await fixtureGit(clone, ["checkout", "-q", ids.base]);
      await fixtureGit(clone, ["checkout", "-q", ids.merge]);
      const { changeSource } = await resolveMergeRequest(clone, access);
      expect(changeSource.revision.head).toBe(ids.merge);
    },
    testTimeoutMs(60_000),
  );

  it.each([
    ["an open", "head", { state: "opened", merged_at: null }, "second"],
    ["a fast-forward merged", "head", {}, "second"],
    ["an open", "old side", { state: "opened", merged_at: null }, "second"],
    ["a fast-forward merged", "old side", {}, "second"],
    ["a merge-commit merged", "old side", {}, "merge"],
    ["a squash merged", "old side", {}, "squash"],
  ] as const)(
    "refuses %s merge request in a treeless clone positioned on its %s, since the other side's trees are absent",
    async (_label, position, fields, commit) => {
      const ids = await mergeRequestRepository();
      const head = ids[commit];
      const singleCommit = commit !== "second";
      const oldSide = singleCommit
        ? await fixtureGit(ids.repository, ["rev-parse", `${head}^`])
        : ids.base;
      // A treeless clone already holds every commit, as after a fetch that brings commits only.
      const clone = await partialClone(ids.repository, "tree:0");
      if (position === "head") {
        // Checking out the head fetches its trees and blobs, never the old side's.
        await fixtureGit(clone, ["checkout", "-q", head]);
      } else {
        // A plain checkout would first read main's tree, the head's, and so fetch it.
        await fixtureGit(clone, ["update-ref", "--no-deref", "HEAD", oldSide]);
        await fixtureGit(clone, ["checkout", "-q", oldSide]);
      }
      const { access } = pinOnly(
        recordedMergeRequest(
          {
            base: ids.base,
            start: ids.base,
            head: ids.second,
            merge: commit === "merge" ? ids.merge : null,
          },
          { ...fields, ...(commit === "squash" ? { squash_commit_sha: ids.squash } : {}) },
        ),
      );
      const git: string[][] = [];
      const error = await resolveMergeRequest(clone, access, {
        observeGit: (args) => git.push([...args]),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(
        bothFailed(`tree in a partial clone; sides ${oldSide} then ${head}`),
      );
      expect(git.map((args) => args[0])).not.toContain("diff-tree");
      expect(git.flat()).not.toContain("fetch");
      // Adjacent: once both sides' trees and blobs are local, the same range admits.
      if (position === "head") await fixtureGit(clone, ["checkout", "-q", oldSide]);
      await fixtureGit(clone, ["checkout", "-q", head]);
      const { changeSource } = await resolveMergeRequest(clone, access);
      expect(changeSource.rangeSemantics).toBe(singleCommit ? "first-parent-commit" : "two-dot");
      expect(changeSource.revision).toMatchObject({ base: oldSide, head });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a partial clone that lacks a pinned commit, naming the commit, without a lazy fetch",
    async () => {
      const ids = await mergeRequestRepository();
      // Only main is cloned, so the squash commit on its own branch is not here.
      const clone = await partialClone(ids.repository, "blob:none", "main");
      const { access } = pinOnly(
        recordedMergeRequest(
          { base: ids.base, start: ids.base, head: ids.second, merge: null },
          { squash_commit_sha: ids.squash },
        ),
      );
      const git: string[][] = [];
      const error = await resolveMergeRequest(clone, access, {
        observeGit: (args) => git.push([...args]),
      }).catch((caught: unknown) => caught);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(bothFailed("squash commit"));
      // Only the probe that never fetches has read the absent commit.
      expect(git.map((args) => args[0])).toEqual(["config", "rev-list"]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "treats extensions.partialclone alone, the older layout, as a partial clone",
    async () => {
      const ids = await mergeRequestRepository();
      const clone = await partialClone(ids.repository, "blob:none");
      // Git before 2.24 named the promisor remote only in this repository extension.
      await fixtureGit(clone, ["config", "--unset", "remote.origin.promisor"]);
      await fixtureGit(clone, ["config", "core.repositoryformatversion", "1"]);
      await fixtureGit(clone, ["config", "extensions.partialclone", "origin"]);
      expect(
        await fixtureGit(clone, [
          "config",
          "--get-regexp",
          "^(remote\\..+\\.promisor|extensions\\.partialclone)$",
        ]),
      ).toBe("extensions.partialclone origin");
      const { access } = pinOnly(
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const error = await resolveMergeRequest(clone, access).catch((caught: unknown) => caught);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(
        bothFailed(`file blob in a partial clone; sides ${ids.base} then ${ids.merge}`),
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a damaged tree outside a partial clone as a git failure, not as unavailable objects",
    async () => {
      const ids = await mergeRequestRepository();
      const tree = await fixtureGit(ids.repository, ["rev-parse", `${ids.base}^{tree}`]);
      await rm(join(ids.repository, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
      const { access } = forge(() =>
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const error = await resolveMergeRequest(ids.repository, access).catch(
        (caught: unknown) => caught,
      );
      expect((error as ChangeSourceError).code).toBe("change-source-git-failed");
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a partial-clone config read that cannot complete, rather than reading it as not partial",
    async () => {
      const ids = await mergeRequestRepository();
      // A promisor value longer than an ordinary git read's output allowance.
      const oversized = "x".repeat(limit("hostInvoker.gitDefaultOutputMaxBytes").value + 1);
      await appendFile(
        join(ids.repository, ".git", "config"),
        `[remote "spare"]\n\tpromisor = ${oversized}\n`,
      );
      const { access } = forge(() =>
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const git: string[][] = [];
      const error = await resolveMergeRequest(ids.repository, access, {
        observeGit: (args) => git.push([...args]),
      }).catch((caught: unknown) => caught);
      expect((error as ChangeSourceError).code).toBe("change-source-git-failed");
      // The refusal comes from the config read itself; no object read follows it.
      expect(git.map((args) => args[0])).toEqual(["config"]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "maps a shallow clone's missing history to unavailable objects",
    async () => {
      const ids = await mergeRequestRepository();
      const clone = join(await roots.create("docsfab-change-source-gitlab-shallow-"), "clone");
      await fixtureGit(ids.repository, [
        "clone",
        "-q",
        "--depth=1",
        "-b",
        "main",
        `file://${ids.repository}`,
        clone,
      ]);
      const { access } = pinOnly(
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const error = await resolveMergeRequest(clone, access).catch((caught: unknown) => caught);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(
        bothFailed("commit history, change-source-history-unavailable"),
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "maps an unresolvable parent behind a present merge commit to unavailable objects",
    async () => {
      const ids = await mergeRequestRepository();
      // The merge commit is here; the first parent its diff reads is not.
      await rm(join(ids.repository, ".git", "objects", ids.base.slice(0, 2), ids.base.slice(2)));
      expect(await fixtureGit(ids.repository, ["cat-file", "-t", ids.merge])).toBe("commit");
      const { access } = pinOnly(
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const error = await resolveMergeRequest(ids.repository, access).catch(
        (caught: unknown) => caught,
      );
      expect((error as ChangeSourceError).code).toBe("change-source-mr-objects-unavailable");
      expect((error as ChangeSourceError).detail).toBe(
        bothFailed("commit history, change-source-revision-unresolved"),
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a tampered interior commit as damage, not as unavailable objects",
    async () => {
      const ids = await mergeRequestRepository();
      await rewriteLooseObject(ids.repository, ids.first, (body) =>
        Buffer.from(body.toString("latin1").replace("Edit the guide", "EDIT THE GUIDE"), "latin1"),
      );
      const { calls, access } = forge(() =>
        recordedMergeRequest(
          { base: ids.base, start: ids.base, head: ids.second, merge: null },
          { state: "opened", merged_at: null },
        ),
      );
      const error = await resolveMergeRequest(ids.repository, access).catch(
        (caught: unknown) => caught,
      );
      expect((error as ChangeSourceError).code).toBe("change-source-integrity-mismatch");
      expect(calls).toHaveLength(1);
    },
    testTimeoutMs(60_000),
  );

  it(
    "reads another project's merge request locally when its objects are here, under that project's identity",
    async () => {
      const ids = await mergeRequestRepository();
      const otherPath = "other-group/other-project";
      const { calls, access } = forge(() =>
        recordedMergeRequest(
          { base: ids.base, start: ids.base, head: ids.second, merge: ids.merge },
          {
            iid: 7,
            project_id: 999,
            target_project_id: 999,
            source_project_id: 1001,
            references: { full: `Other-Group/Other-Project!7` },
          },
        ),
      );
      const { changeSource } = await resolveMergeRequest(ids.repository, access, {
        selector: `${HOST}/${otherPath}!7`,
      });
      expect(sourceOf(changeSource)).toMatchObject({
        projectPath: "Other-Group/Other-Project",
        projectId: 999,
        iid: 7,
        fork: true,
      });
      expect(changeSource.revision.repository).toEqual(
        gitlabProjectIdentity({ host: HOST, projectId: 999 }),
      );
      expect(calls[0]!.args.at(-1)).toBe(
        `projects/${encodeURIComponent(otherPath)}/merge_requests/7`,
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "resolves !N against the checkout's own GitLab remote, with glab on the injected seam",
    async () => {
      const ids = await mergeRequestRepository();
      await fixtureGit(ids.repository, [
        "remote",
        "add",
        "origin",
        `git@${HOST}:${PROJECT_PATH}.git`,
      ]);
      const { calls, access } = forge((endpoint) =>
        endpoint.includes("/merge_requests/")
          ? recordedMergeRequest({
              base: ids.base,
              start: ids.base,
              head: ids.second,
              merge: ids.merge,
            })
          : { id: PROJECT_ID, path_with_namespace: PROJECT_PATH },
      );
      const { changeSource } = await resolveMergeRequest(ids.repository, access, {
        selector: `!${IID}`,
      });
      expect(sourceOf(changeSource)).toMatchObject({ host: HOST, projectPath: PROJECT_PATH });
      expect(calls.every((call) => call.command === "glab")).toBe(true);
      expect(calls.at(-1)!.args.at(-1)).toBe(MR_ENDPOINT);
    },
    testTimeoutMs(60_000),
  );
});

describe("merge request bounds reuse the change-source limits", () => {
  async function openRequest() {
    const ids = await mergeRequestRepository();
    const { access } = forge(() =>
      recordedMergeRequest(
        { base: ids.base, start: ids.base, head: ids.second, merge: null },
        { state: "opened", merged_at: null },
      ),
    );
    return { ids, resolve: () => resolveMergeRequest(ids.repository, access) };
  }

  it(
    "admits each count at its limit and refuses one over with the observed value",
    async () => {
      const { resolve } = await openRequest();
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 2);
      expect((await resolve()).changeSource.commits).toHaveLength(
        limit("changeSources.commitsMax").value,
      );
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 1);
      const commits = await resolve().catch((caught: unknown) => caught);
      expect(commits).toBeInstanceOf(OperationalLimitError);
      expect(commits).toMatchObject({ code: "change-source-commits-bound", observed: 2 });
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 2);
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 2);
      expect((await resolve()).changeSource.files).toHaveLength(
        limit("changeSources.changedFilesMax").value,
      );
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 1);
      expect(await resolve().catch((caught: unknown) => caught)).toMatchObject({
        code: "change-source-changed-files-bound",
        observed: 2,
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits a diff at its byte limit, refuses one byte under it, and omits a file over its own limit",
    async () => {
      const { resolve } = await openRequest();
      const size = (await resolve()).diffBytes.byteLength;
      override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", size);
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", size);
      expect((await resolve()).diffBytes.byteLength).toBe(
        limit("changeSources.diffMaxBytes").value,
      );
      override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", size - 1);
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", size - 1);
      expect(await codeOf(resolve())).toBe("change-source-diff-bound");
      override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", size);
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", 1);
      const omitted = await resolve();
      expect(omitted.changeSource.files.map((file) => file.diffOmitted?.limitName ?? null)).toEqual(
        ["changeSources.fileDiffMaxBytes", "changeSources.fileDiffMaxBytes"],
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("the local arm's text screens", () => {
  async function requestWith(files: Readonly<Record<string, string | Uint8Array>>) {
    const { repository } = await initChangeRepository(
      await roots.create("docsfab-change-source-gitlab-screen-"),
    );
    const base = await fixtureGit(repository, ["rev-parse", "HEAD"]);
    const head = await commitFiles(repository, files, "Change");
    const { access } = forge(() =>
      recordedMergeRequest(
        { base, start: base, head, merge: null },
        { state: "opened", merged_at: null },
      ),
    );
    return resolveMergeRequest(repository, access);
  }

  it(
    "refuses a configured credential and non-UTF-8 text by their own codes, and admits look-alikes",
    async () => {
      const token = configureCredential(["glpat", "Hn3Kp8Ws2Zx6Qd4Vb7Lm9Rt"].join("-"));
      expect(await codeOf(requestWith({ "docs/config.md": `token: ${token}\n` }))).toBe(
        "change-source-credential-present",
      );
      expect(
        await codeOf(
          requestWith({ "docs/latin1.md": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) }),
        ),
      ).toBe("change-source-encoding-unsupported");
      const documentationKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
      const placeholder = ["glpat", "x".repeat(20)].join("-");
      const admitted = await requestWith({
        "docs/aws.md": `Set AWS_ACCESS_KEY_ID=${documentationKey} in the example.\n`,
        "docs/token.md": `export GITLAB_TOKEN=${placeholder}\n`,
      });
      expect(admitted.changeSource.files.map((file) => file.newPath)).toEqual([
        "docs/aws.md",
        "docs/token.md",
      ]);
    },
    testTimeoutMs(60_000),
  );
});

describe("--change and --mr name a GitLab merge request the same way", () => {
  const BASE = [
    "update-documentation",
    "--repo",
    "/tmp/change-source-gitlab",
    "--instruction",
    "Update the export guide.",
  ];

  it("parses each merge request form into the merge request kind, and a bare number as a commit", () => {
    expect(parseChangeSourceSelector(MR_URL)).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "gitlab-merge-request",
      changeRequest: {
        schemaVersion: 1,
        kind: "docsfab-change-request-selector",
        provider: "gitlab",
        host: HOST,
        projectPath: PROJECT_PATH,
        number: IID,
      },
    });
    expect(parseChangeSourceSelector(`${HOST}/${PROJECT_PATH}!${IID}`)).toEqual(
      parseChangeSourceSelector(MR_URL),
    );
    expect(parseChangeSourceSelector(`!${IID}`)).toMatchObject({
      source: "gitlab-merge-request",
      changeRequest: { host: null, projectPath: null, number: IID },
    });
    expect(parseChangeSourceSelector(`${IID}`)).toMatchObject({
      source: "local-range",
      form: "single-commit",
      head: `${IID}`,
    });
  });

  it("keeps another forge's forms unsupported and refuses a hostless path through the --mr grammar", () => {
    for (const value of [
      "https://forge.example.test/org/repo/pull/7",
      "github.com/org/repo/pull/7",
    ]) {
      const error = (() => {
        try {
          parseChangeSourceSelector(value);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-kind-unsupported");
      expect((error as Error).message).not.toContain(value);
    }
    const hostless = (() => {
      try {
        parseChangeSourceSelector(`team/docs-project!${IID}`);
      } catch (caught) {
        return caught;
      }
    })();
    expect(hostless).toBeInstanceOf(ChangeRequestSelectorError);
    expect((hostless as ChangeRequestSelectorError).code).toBe("ambiguous-reference");
    expect((hostless as Error).message).not.toContain("team/docs-project");
  });

  it("gives run --mr the same merge request change as --change, and keeps the two exclusive", () => {
    const viaMr = parseRunArguments([...BASE, "--mr", MR_URL]);
    const viaChange = parseRunArguments([...BASE, "--change", MR_URL]);
    expect(viaMr.changeSource).toEqual(viaChange.changeSource);
    expect(viaMr.changeSource).toMatchObject({ source: "gitlab-merge-request" });
    expect(viaMr.changeRequestSelector).toEqual(
      (viaChange.changeSource as GitLabMergeRequestSelectorV1).changeRequest,
    );
    expect(viaChange.changeRequestSelector).toBeUndefined();
    // Adjacent: without --mr a run names no merge request change.
    expect(parseRunArguments([...BASE]).changeSource).toBeUndefined();
    const conflict = (() => {
      try {
        parseRunArguments([...BASE, "--change", MR_URL, "--mr", MR_URL]);
      } catch (caught) {
        return caught;
      }
    })();
    expect((conflict as ChangeSourceError).code).toBe("change-source-selector-conflict");
  });

  it("binds run --mr's merge request as the change beside a comparison, as --change does", () => {
    const codeOfParse = (args: readonly string[]) => {
      try {
        parseRunArguments([...args]);
        return undefined;
      } catch (caught) {
        return (caught as { code?: string }).code;
      }
    };
    for (const option of ["--mr", "--pr", "--change"]) {
      const args = [...BASE, option, MR_URL, "--comparison-workspace"];
      expect(codeOfParse(args), option).toBeUndefined();
      const parsed = parseRunArguments(args);
      expect(parsed.changeSource, option).toMatchObject({ source: "gitlab-merge-request" });
      expect(parsed.comparisonRequest, option).toEqual({ kind: "workspace" });
    }
    // Adjacent: the comparison alone, and --mr alone, both parse.
    expect(codeOfParse([...BASE, "--comparison-workspace"])).toBeUndefined();
    expect(codeOfParse([...BASE, "--mr", MR_URL])).toBeUndefined();
  });
});

describe("the shipped kind dispatch", () => {
  function workspaceOf(repository: string, revision: string): RepositoryWorkspace {
    return {
      path: repository,
      sourcePath: repository,
      requestedRevision: "HEAD",
      revision,
      dispose: async () => undefined,
    };
  }

  it(
    "routes a merge request selector to its arm with the forge it is given, and refuses without one",
    async () => {
      const ids = await mergeRequestRepository();
      const { calls, access } = forge(() =>
        recordedMergeRequest({
          base: ids.base,
          start: ids.base,
          head: ids.second,
          merge: ids.merge,
        }),
      );
      const workspace = workspaceOf(ids.repository, ids.merge);
      const selector = parseChangeSourceSelector(MR_URL);
      const resolved = await resolveCliChangeSource({ workspace, selector, forge: access });
      expect(resolved.changeSource.source.kind).toBe("gitlab-merge-request");
      expect(calls).toHaveLength(1);
      expect(await codeOf(resolveCliChangeSource({ workspace, selector }))).toBe(
        "change-source-resolution-missing",
      );
    },
    testTimeoutMs(60_000),
  );
});
