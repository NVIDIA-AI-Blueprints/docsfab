// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The GitLab merge request change source, forge arm: a checkout without the
 * merge request's objects reads its diff from GitLab, through recorded
 * `glab api` answers on the forge command seam. Each forge record is compared
 * with the local-verified record of the same merge request, read from the
 * full fixture repository.
 */
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveCliChangeSource,
  resolveCliChangeSourceEvidence,
} from "../src/cli/run/source-acquisition.js";
import { OperationalLimitError, limit } from "../src/config/limits.js";
import {
  ChangeSourceError,
  decodeChangeSourceV1,
  parseChangeSourceSelector,
  type ChangeSourceMemberV1,
  type ChangeSourceV1,
  type GitLabMergeRequestSelectorV1,
  type ResolvedChangeSourceV1,
} from "../src/inputs/change-source.js";
import { changeSourceProducerId } from "../src/inputs/change-source/acquisition.js";
import { resolveGitLabMergeRequestChangeSource } from "../src/inputs/change-source/gitlab.js";
import { gitlabProjectIdentity } from "../src/inputs/change-source/revision.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  commitFiles,
  fixtureGit,
  initChangeRepository,
  rewriteLooseObject,
} from "./support/change-source-fixture.js";
import {
  commitGet,
  commitGetOf,
  commitsItem,
  commitsItemOf,
  diffItemOf,
  diffItems,
  ENDPOINTS,
  FORGE_HOST,
  FORGE_IID,
  FORGE_PAGE_SIZE,
  FORGE_PROJECT_ID,
  FORGE_PROJECT_PATH,
  gitBytes,
  LOGIN_EXPIRED,
  mergeRequestGet,
  RecordedGitLab,
} from "./support/gitlab-forge-fixture.js";

const MR_URL = `https://${FORGE_HOST}/${FORGE_PROJECT_PATH}/-/merge_requests/${FORGE_IID}`;
const IDENTITY = gitlabProjectIdentity({ host: FORGE_HOST, projectId: FORGE_PROJECT_ID });

const roots = temporaryRoots();
const overrides: string[] = [];

function override(variable: string, value: number): void {
  overrides.push(variable);
  process.env[variable] = String(value);
}

afterEach(() => {
  for (const variable of overrides.splice(0)) delete process.env[variable];
});

type Resolved = ResolvedChangeSourceV1<ChangeSourceMemberV1>;

async function resolve(
  sourcePath: string,
  gitlab: RecordedGitLab,
  extra: {
    readonly workspaceRevision?: string;
    readonly observeGit?: (args: readonly string[]) => void;
    readonly onStatus?: (message: string) => void;
  } = {},
): Promise<Resolved> {
  return resolveGitLabMergeRequestChangeSource({
    selector: parseChangeSourceSelector(MR_URL) as GitLabMergeRequestSelectorV1,
    sourcePath,
    repositoryPath: sourcePath,
    workspaceRevision:
      extra.workspaceRevision ?? (await fixtureGit(sourcePath, ["rev-parse", "HEAD"])),
    forge: gitlab.access(),
    ...(extra.observeGit ? { observeGit: extra.observeGit } : {}),
    ...(extra.onStatus ? { onStatus: extra.onStatus } : {}),
  });
}

/** The refusal a resolve ends in: its code and detail, or `admitted`. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  try {
    await promise;
    return { code: "admitted" };
  } catch (error) {
    const caught = error as { code?: string; detail?: string };
    return {
      code: caught.code ?? `uncoded: ${String(error)}`,
      ...(caught.detail === undefined ? {} : { detail: caught.detail }),
    };
  }
}

function text(resolved: Resolved): string {
  return Buffer.from(resolved.diffBytes).toString("utf8");
}

function source(changeSource: ChangeSourceV1<ChangeSourceMemberV1>) {
  return changeSource.source as unknown as Record<string, unknown>;
}

/**
 * `main` at `base`; `feature` adds two commits; `main` takes them through a
 * merge commit, and `squashed` takes them as one squash commit.
 */
async function mergeRequestRepository() {
  const { repository } = await initChangeRepository(await roots.create("docsfab-gitlab-forge-"), {
    "README.md": "# Fixture\n",
    "docs/guide.md": "one\ntwo\n",
  });
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

/** A clone holding `base` and its history only: none of the merge request's commits. */
async function checkoutWithout(repository: string, base: string): Promise<string> {
  await fixtureGit(repository, ["branch", "-f", "base-only", base]);
  const clone = join(await roots.create("docsfab-gitlab-forge-checkout-"), "clone");
  await fixtureGit(repository, [
    "clone",
    "-q",
    "--single-branch",
    "-b",
    "base-only",
    `file://${repository}`,
    clone,
  ]);
  return clone;
}

/** A `--no-checkout` partial clone of `repository`. */
async function partialClone(repository: string, filter: "blob:none" | "tree:0"): Promise<string> {
  await fixtureGit(repository, ["config", "uploadpack.allowFilter", "true"]);
  const clone = join(await roots.create("docsfab-gitlab-forge-partial-"), "clone");
  await fixtureGit(repository, [
    "clone",
    "-q",
    `--filter=${filter}`,
    "--no-checkout",
    `file://${repository}`,
    clone,
  ]);
  return clone;
}

/** GitLab for a merge request merged through `commit` (merge or squash), read through its commit diff. */
async function commitForge(
  repository: string,
  pin: Record<string, unknown>,
  commit: string,
  generated: boolean | null = null,
): Promise<RecordedGitLab> {
  const parent = (await gitBytes(repository, ["rev-parse", `${commit}^`])).toString().trim();
  return new RecordedGitLab()
    .on(ENDPOINTS.pin, pin)
    .on(ENDPOINTS.reread, pin)
    .on(ENDPOINTS.commit(commit), await commitGet(repository, commit))
    .paged(
      (page) => ENDPOINTS.commitDiff(commit, page),
      await diffItems(repository, parent, commit, generated),
    );
}

/** GitLab for an open (or fast-forward merged) merge request, read through `/diffs`. */
async function diffsForge(
  repository: string,
  pin: Record<string, unknown>,
  base: string,
  commitsNewestFirst: readonly string[],
): Promise<RecordedGitLab> {
  const head = commitsNewestFirst[0]!;
  return new RecordedGitLab()
    .on(ENDPOINTS.pin, pin)
    .on(ENDPOINTS.reread, pin)
    .paged((page) => ENDPOINTS.diffs(page), await diffItems(repository, base, head, false))
    .paged(
      (page) => ENDPOINTS.commits(base, head, page),
      await Promise.all(commitsNewestFirst.map((sha) => commitsItem(repository, sha))),
    );
}

/**
 * Twin parity: the fields a forge record and a local-verified record of one
 * merge request must agree on, in the same file order.
 */
function parity(changeSource: ChangeSourceV1<ChangeSourceMemberV1>) {
  const { provenance: _provenance, ...member } = source(changeSource);
  return {
    member,
    revision: changeSource.revision,
    objectFormat: changeSource.objectFormat,
    rangeSemantics: changeSource.rangeSemantics,
    diffFrom: changeSource.diffFrom,
    mergeBase: changeSource.mergeBase,
    commits: changeSource.commits,
    labels: changeSource.labels,
    files: changeSource.files.map((file) => ({
      status: file.status,
      oldPath: file.oldPath,
      newPath: file.newPath,
      oldMode: file.oldMode,
      newMode: file.newMode,
      binary: file.binary,
    })),
  };
}

/** Git's own patch, less the lines GitLab cannot supply: blob ids and the rename score. */
function withoutIndexLines(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => !line.startsWith("index ") && !line.startsWith("similarity index "))
    .join("\n");
}

const FORGE_LINE = (detail: string) =>
  `change source: merge request !${FORGE_IID} diff read from GitLab (forge-reported), because this checkout lacks objects it reads: change-source-mr-objects-unavailable (${detail})`;

describe("a squash-merged multi-commit merge request whose objects are not local", () => {
  it(
    "reads the squash commit's diff from GitLab, and agrees with the local twin field for field",
    async () => {
      const ids = await mergeRequestRepository();
      const checkout = await checkoutWithout(ids.repository, ids.base);
      const pin = mergeRequestGet(
        { base: ids.base, start: ids.base, head: ids.second, merge: null },
        { squash_commit_sha: ids.squash, squash: true },
      );
      const gitlab = await commitForge(ids.repository, pin, ids.squash);
      const status: string[] = [];
      const forge = await resolve(checkout, gitlab, { onStatus: (line) => status.push(line) });
      const { changeSource } = forge;

      expect(source(changeSource)).toEqual({
        kind: "gitlab-merge-request",
        provenance: "forge-reported",
        host: FORGE_HOST,
        projectPath: FORGE_PROJECT_PATH,
        projectId: FORGE_PROJECT_ID,
        iid: FORGE_IID,
        state: "merged",
        mergeMode: "squash",
        diffRefs: { base: ids.base, start: ids.base, head: ids.second },
        mergeCommit: null,
        squashCommit: ids.squash,
        fork: false,
      });
      // The squash commit is the change, never the branch's pre-squash commits.
      expect(changeSource.commits).toEqual([
        { id: ids.squash, parents: [ids.base], subject: "Require an explicit export path" },
      ]);
      expect(changeSource.protocol).toEqual({ provider: "gitlab" });
      expect([changeSource.baseTree, changeSource.headTree]).toEqual([null, null]);
      expect(changeSource.files.map((file) => [file.oldBlob, file.newBlob])).toEqual([
        [null, null],
        [null, null],
      ]);
      expect(text(forge)).toBe(
        [
          "diff --git a/docs/guide.md b/docs/guide.md",
          "--- a/docs/guide.md",
          "+++ b/docs/guide.md",
          "@@ -1,2 +1,2 @@",
          " one",
          "-two",
          "+TWO",
          "diff --git a/docs/new.md b/docs/new.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/docs/new.md",
          "@@ -0,0 +1 @@",
          "+new page",
          "",
        ].join("\n"),
      );
      // The sealed manifest decodes under the shipped codec.
      const manifest = JSON.parse(Buffer.from(forge.manifestBytes).toString("utf8"));
      expect(decodeChangeSourceV1(manifest)).toEqual(changeSource);
      expect(changeSourceProducerId(changeSource)).toBe("change-source-gitlab-forge");
      // Every read is a GET on the selector's host, ending with the merge request read again.
      expect(gitlab.endpoints()).toEqual([
        ENDPOINTS.pin,
        ENDPOINTS.commit(ids.squash),
        ENDPOINTS.commitDiff(ids.squash, 1),
        ENDPOINTS.reread,
      ]);
      for (const args of gitlab.calls) {
        expect(args.slice(0, 5)).toEqual(["api", "--hostname", FORGE_HOST, "--method", "GET"]);
      }
      expect(status).toContain(FORGE_LINE("squash commit"));

      // The local twin: the same merge request where the objects are, read with no forge diff.
      const local = new RecordedGitLab().on(ENDPOINTS.pin, pin);
      const twin = await resolve(ids.repository, local, { workspaceRevision: ids.squash });
      expect(source(twin.changeSource).provenance).toBe("local-verified");
      expect(local.endpoints()).toEqual([ENDPOINTS.pin]);
      expect(parity(changeSource)).toEqual(parity(twin.changeSource));
      expect(text(forge)).toBe(withoutIndexLines(text(twin)));
    },
    testTimeoutMs(60_000),
  );

  it(
    "mints both observations under the forge producer, each a version of its own bytes",
    async () => {
      const ids = await mergeRequestRepository();
      const checkout = await checkoutWithout(ids.repository, ids.base);
      const pin = mergeRequestGet(
        { base: ids.base, start: ids.base, head: ids.second, merge: null },
        { squash_commit_sha: ids.squash, squash: true },
      );
      const forge = await resolve(checkout, await commitForge(ids.repository, pin, ids.squash));
      const twin = await resolve(ids.repository, new RecordedGitLab().on(ENDPOINTS.pin, pin), {
        workspaceRevision: ids.squash,
      });
      const workspace = await prepareRepositoryWorkspace(checkout, "HEAD");
      try {
        const mint = (resolved: Resolved) =>
          resolveCliChangeSourceEvidence({
            workspace,
            resolved,
            admittedRequest: { workflow: "update-documentation", allowWrite: false },
            runId: "gitlab-forge-producer",
          });
        const forgeEvidence = await mint(forge);
        const twinEvidence = await mint(twin);
        expect(forgeEvidence.acquired.producerScopes[0]!.producerId).toBe(
          "change-source-gitlab-forge",
        );
        expect(twinEvidence.acquired.producerScopes[0]!.producerId).toBe(
          "change-source-gitlab-local",
        );
        for (const entry of forgeEvidence.acquired.acquired) {
          expect(entry.observation.producerId).toBe("change-source-gitlab-forge");
          expect(entry.observation.original.version).toEqual({
            kind: "content-digest",
            contentDigestSha256: entry.observation.original.sha256,
          });
        }
        for (const entry of twinEvidence.acquired.acquired) {
          expect(entry.observation.original.version).toEqual({
            kind: "repository-revision",
            revision: ids.squash,
          });
        }
        // One merge request, one origin per role; the bytes differ, so the observations do.
        const origins = (evidence: typeof forgeEvidence) =>
          evidence.acquired.acquired.map((entry) => entry.observation.originIdSha256);
        expect(origins(forgeEvidence)).toEqual(origins(twinEvidence));
        expect(forgeEvidence.acquired.acquired[0]!.observation.observationId).not.toBe(
          twinEvidence.acquired.acquired[0]!.observation.observationId,
        );
      } finally {
        await workspace.dispose();
      }
    },
    testTimeoutMs(60_000),
  );
});

describe("an open multi-commit merge request whose objects are not local", () => {
  async function openRequest() {
    const ids = await mergeRequestRepository();
    const checkout = await checkoutWithout(ids.repository, ids.base);
    const pin = mergeRequestGet(
      { base: ids.base, start: ids.base, head: ids.second, merge: null },
      { state: "opened", merged_at: null },
    );
    return { ids, checkout, pin };
  }

  it(
    "reads base to head from /diffs and the commits oldest first, labelled unmerged",
    async () => {
      const { ids, checkout, pin } = await openRequest();
      const gitlab = await diffsForge(ids.repository, pin, ids.base, [ids.second, ids.first]);
      const status: string[] = [];
      const forge = await resolve(checkout, gitlab, { onStatus: (line) => status.push(line) });
      const { changeSource } = forge;
      expect(source(changeSource)).toMatchObject({
        provenance: "forge-reported",
        state: "opened",
        mergeMode: null,
      });
      expect(changeSource.rangeSemantics).toBe("two-dot");
      expect(changeSource.revision).toEqual({
        schemaVersion: 1,
        kind: "docsfab-pinned-repository-revision",
        repository: IDENTITY,
        base: ids.base,
        head: ids.second,
      });
      expect([changeSource.mergeBase, changeSource.diffFrom]).toEqual([ids.base, ids.base]);
      // GitLab lists newest first; the record is oldest first.
      expect(changeSource.commits).toEqual([
        { id: ids.first, parents: [ids.base], subject: "Edit the guide" },
        { id: ids.second, parents: [ids.first], subject: "Add a page" },
      ]);
      expect(changeSource.labels).toEqual(["merge-request-unmerged"]);
      expect(gitlab.endpoints()).toEqual([
        ENDPOINTS.pin,
        ENDPOINTS.diffs(1),
        ENDPOINTS.commits(ids.base, ids.second, 1),
        ENDPOINTS.reread,
      ]);
      expect(status).toEqual([
        FORGE_LINE("head"),
        `change source: GitLab declares no commit count for merge request !${FORGE_IID}, so its commit list is checked only against the pinned head`,
        `change source: merge request !${FORGE_IID} is open; its description was not bound, because an open merge request's text can still change`,
      ]);
      // The local twin of the same open merge request.
      const twin = await resolve(ids.repository, new RecordedGitLab().on(ENDPOINTS.pin, pin), {
        workspaceRevision: ids.second,
      });
      expect(parity(changeSource)).toEqual(parity(twin.changeSource));
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a commit list whose newest commit is not the pinned head",
    async () => {
      const { ids, checkout, pin } = await openRequest();
      // Oldest first, as no GitLab listing sends it: the newest is not first.
      const gitlab = await diffsForge(ids.repository, pin, ids.base, [ids.second, ids.first]);
      gitlab.paged(
        (page) => ENDPOINTS.commits(ids.base, ids.second, page),
        [
          await commitsItem(ids.repository, ids.first),
          await commitsItem(ids.repository, ids.second),
        ],
      );
      expect(await refusal(resolve(checkout, gitlab))).toEqual({
        code: "change-source-mr-forge-incomplete",
        detail: "commits: the newest listed is not the pinned head",
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits the commit list at changeSources.commitsMax and refuses one over with the count",
    async () => {
      const { ids, checkout, pin } = await openRequest();
      const forge = () => diffsForge(ids.repository, pin, ids.base, [ids.second, ids.first]);
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 2);
      expect((await resolve(checkout, await forge())).changeSource.commits).toHaveLength(
        limit("changeSources.commitsMax").value,
      );
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 1);
      const error = await resolve(checkout, await forge()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OperationalLimitError);
      expect(error).toMatchObject({ code: "change-source-commits-bound", observed: 2 });
    },
    testTimeoutMs(60_000),
  );
});

/**
 * One merge request carrying a fork, a pure rename, a deletion, a binary file
 * with a space and a non-ASCII byte in its name, a mode-only change, a text
 * line that reads like a binary marker, and a merge commit subject longer
 * than GitLab's title.
 */
async function variedRepository() {
  const { repository } = await initChangeRepository(
    await roots.create("docsfab-gitlab-forge-varied-"),
    {
      "README.md": "# Fixture\n",
      "docs/guide.md": "one\ntwo\n",
      "docs/old name.md": "a page that moves under a new name\nand keeps every line\n",
      "docs/remove.md": "a page that goes away\n",
      "scripts/run.sh": "#!/bin/sh\necho run\n",
    },
  );
  const base = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["checkout", "-q", "-b", "feature"]);
  await commitFiles(
    repository,
    {
      "docs/old name.md": null,
      "docs/new name.md": "a page that moves under a new name\nand keeps every line\n",
      "docs/remove.md": null,
      "images/café diagram.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]),
      "docs/guide.md": "one\ntwo\nBinary files a/x and b/x differ\n",
    },
    "Move, remove and add pages",
  );
  await chmod(join(repository, "scripts", "run.sh"), 0o755);
  await fixtureGit(repository, ["add", "scripts/run.sh"]);
  await fixtureGit(repository, ["commit", "-q", "-m", "Make the run script executable"]);
  const head = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["checkout", "-q", "main"]);
  const subject = `Merge branch 'feature' into 'main': ${"move, remove and add pages ".repeat(4).trim()}`;
  await fixtureGit(repository, ["merge", "-q", "--no-ff", "-m", subject, "feature"]);
  const merge = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  return { repository, base, head, merge, subject };
}

describe("a fork merge request with renames, deletions, binaries and mode changes", () => {
  it(
    "lists every status and mode as git does, writes git's headers with no index line, and agrees with its local twin",
    async () => {
      const ids = await variedRepository();
      expect(ids.subject.length).toBeGreaterThan(100);
      const checkout = await checkoutWithout(ids.repository, ids.base);
      const pin = mergeRequestGet(
        { base: ids.base, start: ids.base, head: ids.head, merge: ids.merge },
        { source_project_id: 1001 },
      );
      // GitLab's commit diff sends `generated_file: null`.
      const gitlab = await commitForge(ids.repository, pin, ids.merge, null);
      const recorded = await diffItems(ids.repository, ids.base, ids.merge, null);
      expect(recorded.map((item) => item.generated_file)).toEqual(recorded.map(() => null));
      const forge = await resolve(checkout, gitlab);
      const { changeSource } = forge;
      expect(source(changeSource)).toMatchObject({ fork: true, projectId: FORGE_PROJECT_ID });
      // The target project's identity, never the fork's.
      expect(changeSource.revision.repository).toEqual(IDENTITY);
      expect(changeSource.commits.map((commit) => commit.subject)).toEqual([ids.subject]);
      expect(
        changeSource.files.map((file) => [
          file.status,
          file.oldPath,
          file.newPath,
          file.oldMode,
          file.newMode,
          file.binary,
          file.added,
          file.removed,
          file.diffOmitted ?? null,
        ]),
      ).toEqual([
        ["M", "docs/guide.md", "docs/guide.md", "100644", "100644", false, 1, 0, null],
        // A pure rename: an empty diff, proven empty by the commit's line totals.
        ["R", "docs/old name.md", "docs/new name.md", "100644", "100644", false, 0, 0, null],
        ["D", "docs/remove.md", null, "100644", "000000", false, 0, 1, null],
        ["A", null, "images/café diagram.png", "000000", "100644", true, null, null, null],
        ["M", "scripts/run.sh", "scripts/run.sh", "100644", "100755", false, 0, 0, null],
      ]);
      expect(text(forge)).toBe(
        [
          "diff --git a/docs/guide.md b/docs/guide.md",
          "--- a/docs/guide.md",
          "+++ b/docs/guide.md",
          "@@ -1,2 +1,3 @@",
          " one",
          " two",
          "+Binary files a/x and b/x differ",
          "diff --git a/docs/old name.md b/docs/new name.md",
          "rename from docs/old name.md",
          "rename to docs/new name.md",
          "diff --git a/docs/remove.md b/docs/remove.md",
          "deleted file mode 100644",
          "--- a/docs/remove.md",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-a page that goes away",
          'diff --git "a/images/caf\\303\\251 diagram.png" "b/images/caf\\303\\251 diagram.png"',
          "new file mode 100644",
          'Binary files /dev/null and "b/images/caf\\303\\251 diagram.png" differ',
          "diff --git a/scripts/run.sh b/scripts/run.sh",
          "old mode 100644",
          "new mode 100755",
          "",
        ].join("\n"),
      );
      expect(gitlab.endpoints()).toEqual([
        ENDPOINTS.pin,
        ENDPOINTS.commit(ids.merge),
        ENDPOINTS.commitDiff(ids.merge, 1),
        ENDPOINTS.reread,
      ]);
      const twin = await resolve(ids.repository, new RecordedGitLab().on(ENDPOINTS.pin, pin), {
        workspaceRevision: ids.merge,
      });
      expect(parity(changeSource)).toEqual(parity(twin.changeSource));
      expect(text(forge)).toBe(withoutIndexLines(text(twin)));
    },
    testTimeoutMs(60_000),
  );
});

describe("the merge request is read again after the last page", () => {
  it(
    "refuses a moved head, sha or base, each alone, and admits an unchanged one",
    async () => {
      const ids = await mergeRequestRepository();
      const checkout = await checkoutWithout(ids.repository, ids.base);
      const fields = { state: "opened", merged_at: null };
      const pin = mergeRequestGet(
        { base: ids.base, start: ids.base, head: ids.second, merge: null },
        fields,
      );
      const moved = [
        ["sha", { ...pin, sha: ids.first }],
        [
          "head",
          mergeRequestGet(
            { base: ids.base, start: ids.base, head: ids.first, merge: null },
            { ...fields, sha: ids.second },
          ),
        ],
        [
          "base",
          mergeRequestGet(
            { base: ids.first, start: ids.base, head: ids.second, merge: null },
            fields,
          ),
        ],
      ] as const;
      for (const [label, again] of moved) {
        const gitlab = await diffsForge(ids.repository, pin, ids.base, [ids.second, ids.first]);
        gitlab.on(ENDPOINTS.reread, again);
        expect(await refusal(resolve(checkout, gitlab)), label).toEqual({
          code: "change-source-mr-moved",
        });
        expect(gitlab.endpoints().at(-1), label).toBe(ENDPOINTS.reread);
      }
      const unchanged = await diffsForge(ids.repository, pin, ids.base, [ids.second, ids.first]);
      expect((await resolve(checkout, unchanged)).changeSource.revision.head).toBe(ids.second);
    },
    testTimeoutMs(60_000),
  );
});

/* ---------- completeness, by synthetic answers on a checkout that holds none of their ids ---------- */

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const SQUASH = "d".repeat(40);

async function emptyCheckout(objectFormat: "sha1" | "sha256" = "sha1"): Promise<string> {
  const { repository } = await initChangeRepository(
    await roots.create("docsfab-gitlab-forge-empty-"),
    { "README.md": "# Elsewhere\n" },
    { objectFormat },
  );
  return repository;
}

function added(path: string, lines = 1): Record<string, unknown> {
  return diffItemOf({
    diff: `@@ -0,0 +1${lines === 1 ? "" : `,${lines}`} @@\n${"+line\n".repeat(lines)}`,
    oldPath: path,
    newPath: path,
    aMode: "0",
    bMode: "100644",
    newFile: true,
  });
}

function fileName(index: number): string {
  return `docs/page-${String(index).padStart(4, "0")}.md`;
}

/** An open merge request of `files`, declaring `changesCount`, read through `/diffs`. */
function openForge(
  files: readonly Record<string, unknown>[],
  changesCount: string | null,
  ids: { base: string; head: string } = { base: BASE, head: HEAD },
): RecordedGitLab {
  const pin = mergeRequestGet(
    { base: ids.base, start: ids.base, head: ids.head, merge: null },
    { state: "opened", merged_at: null, changes_count: changesCount },
  );
  return new RecordedGitLab()
    .on(ENDPOINTS.pin, pin)
    .on(ENDPOINTS.reread, pin)
    .paged((page) => ENDPOINTS.diffs(page), files)
    .paged(
      (page) => ENDPOINTS.commits(ids.base, ids.head, page),
      [commitsItemOf({ id: ids.head, parents: [ids.base], message: "Change pages\n" })],
    );
}

/** A squash-merged merge request of `files`, with the squash commit's declared line totals. */
function squashForge(
  files: readonly Record<string, unknown>[],
  stats: { additions: number; deletions: number },
): RecordedGitLab {
  const pin = mergeRequestGet(
    { base: BASE, start: BASE, head: HEAD, merge: null },
    { squash_commit_sha: SQUASH, squash: true },
  );
  return new RecordedGitLab()
    .on(ENDPOINTS.pin, pin)
    .on(ENDPOINTS.reread, pin)
    .on(
      ENDPOINTS.commit(SQUASH),
      commitGetOf({ id: SQUASH, parents: [BASE], message: "Change pages\n" }, stats),
    )
    .paged((page) => ENDPOINTS.commitDiff(SQUASH, page), files);
}

describe("the /diffs arm reads only an exact changed-file count, and all of it", () => {
  it(
    "refuses a capped count as overflow, a missing count as incomplete, and admits the exact count",
    async () => {
      const checkout = await emptyCheckout();
      const files = [added("docs/a.md"), added("docs/b.md")];
      expect((await resolve(checkout, openForge(files, "2"))).changeSource.files).toHaveLength(2);
      for (const capped of ["2+", "3+"]) {
        const gitlab = openForge(files, capped);
        expect(await refusal(resolve(checkout, gitlab)), capped).toEqual({
          code: "change-source-mr-forge-overflow",
          detail: `changes_count ${capped}`,
        });
        // Refused before any diff is read.
        expect(gitlab.endpoints(), capped).toEqual([ENDPOINTS.pin]);
      }
      // No count is not zero files: even an empty listing refuses.
      expect(await refusal(resolve(checkout, openForge([], null)))).toEqual({
        code: "change-source-mr-forge-incomplete",
        detail: "changes_count: none",
      });
      expect(await refusal(resolve(checkout, openForge(files, "3")))).toEqual({
        code: "change-source-mr-forge-incomplete",
        detail: "files: 2 listed of 3",
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a capped count at or over changeSources.changedFilesMax by that limit first",
    async () => {
      const checkout = await emptyCheckout();
      const files = [added("docs/a.md"), added("docs/b.md")];
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 2);
      expect(await refusal(resolve(checkout, openForge(files, "2+")))).toEqual({
        code: "change-source-changed-files-bound",
      });
      expect(await refusal(resolve(checkout, openForge(files, "1+")))).toEqual({
        code: "change-source-mr-forge-overflow",
        detail: "changes_count 1+",
      });
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 1);
      const error = await resolve(checkout, openForge(files, "2")).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "change-source-changed-files-bound", observed: 2 });
    },
    testTimeoutMs(60_000),
  );

  it(
    "pages an exact multiple of the page size through one empty page, and one more file through a short page",
    async () => {
      const checkout = await emptyCheckout();
      const files = Array.from({ length: FORGE_PAGE_SIZE + 1 }, (_, index) =>
        added(fileName(index)),
      );
      const exact = openForge(files.slice(0, FORGE_PAGE_SIZE), String(FORGE_PAGE_SIZE));
      expect((await resolve(checkout, exact)).changeSource.files).toHaveLength(FORGE_PAGE_SIZE);
      expect(exact.endpoints().filter((endpoint) => endpoint.includes("/diffs?"))).toEqual([
        ENDPOINTS.diffs(1),
        ENDPOINTS.diffs(2),
      ]);
      const over = openForge(files, String(FORGE_PAGE_SIZE + 1));
      expect((await resolve(checkout, over)).changeSource.files).toHaveLength(FORGE_PAGE_SIZE + 1);
    },
    testTimeoutMs(60_000),
  );

  it(
    "reads the last page a bounded listing can need, and refuses the page after it unread",
    async () => {
      const checkout = await emptyCheckout();
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", FORGE_PAGE_SIZE);
      const page = Array.from({ length: FORGE_PAGE_SIZE }, (_, index) => added(fileName(index)));
      // At the bound: the second page, empty, is the last one read.
      expect(
        (await resolve(checkout, openForge(page, String(FORGE_PAGE_SIZE)))).changeSource.files,
      ).toHaveLength(limit("changeSources.changedFilesMax").value);
      // GitLab keeps sending full pages past its own count: the third is never requested.
      const runaway = openForge(page, String(FORGE_PAGE_SIZE));
      runaway.on(ENDPOINTS.diffs(2), page);
      const error = await resolve(checkout, runaway).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OperationalLimitError);
      expect(error).toMatchObject({
        code: "change-source-changed-files-bound",
        observed: 2 * FORGE_PAGE_SIZE,
      });
      expect(runaway.endpoints()).not.toContain(ENDPOINTS.diffs(3));
    },
    testTimeoutMs(60_000),
  );

  it(
    "lists every empty /diffs diff as a forge omission, a pure rename and a modified file alike",
    async () => {
      const checkout = await emptyCheckout();
      const files = [
        diffItemOf({
          diff: "",
          oldPath: "docs/old.md",
          newPath: "docs/new.md",
          aMode: "100644",
          bMode: "100644",
          renamedFile: true,
        }),
        diffItemOf({
          diff: "",
          oldPath: "docs/page.md",
          newPath: "docs/page.md",
          aMode: "100644",
          bMode: "100644",
        }),
        added("docs/z.md"),
      ];
      const status: string[] = [];
      const resolved = await resolveCliChangeSource({
        workspace: {
          path: checkout,
          sourcePath: checkout,
          requestedRevision: "HEAD",
          revision: await fixtureGit(checkout, ["rev-parse", "HEAD"]),
          dispose: async () => undefined,
        },
        selector: parseChangeSourceSelector(MR_URL),
        forge: openForge(files, "3").access(),
        onStatus: (line) => status.push(line),
      });
      expect(
        resolved.changeSource.files.map((file) => [file.status, file.diffOmitted ?? null]),
      ).toEqual([
        [
          "R",
          {
            code: "change-source-file-diff-omitted",
            basis: "forge-omitted",
            forgeReason: "no-patch",
          },
        ],
        [
          "M",
          {
            code: "change-source-file-diff-omitted",
            basis: "forge-omitted",
            forgeReason: "no-patch",
          },
        ],
        ["A", null],
      ]);
      expect(status).toContain(
        "change-source-file-diff-omitted: docs/new.md diff was not sent by the forge (no-patch); it stays listed in the change manifest without its diff",
      );
      expect(status).toContain(
        "change-source-file-diff-omitted: docs/page.md diff was not sent by the forge (no-patch); it stays listed in the change manifest without its diff",
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("the commit-diff arm checks every page against the commit's line totals", () => {
  const deletion = diffItemOf({
    diff: "@@ -1,2 +0,0 @@\n-gone\n-gone too\n",
    oldPath: "docs/gone.md",
    newPath: "docs/gone.md",
    aMode: "100644",
    bMode: "0",
    deletedFile: true,
  });

  it(
    "admits matching totals, and refuses a dropped deletions-only file and a collapsed file",
    async () => {
      const checkout = await emptyCheckout();
      const files = [added("docs/a.md", 2), deletion];
      expect(
        (await resolve(checkout, squashForge(files, { additions: 2, deletions: 2 }))).changeSource
          .files,
      ).toHaveLength(2);
      // The deletions-only file is missing; the additions alone still agree.
      expect(
        await refusal(resolve(checkout, squashForge([files[0]!], { additions: 2, deletions: 2 }))),
      ).toEqual({
        code: "change-source-mr-forge-incomplete",
        detail: "lines: 2+0 listed of 2+2",
      });
      // GitLab collapsed a file it counts lines for: its diff is empty.
      const collapsed = diffItemOf({
        diff: "",
        oldPath: "docs/big.md",
        newPath: "docs/big.md",
        aMode: "100644",
        bMode: "100644",
      });
      expect(
        await refusal(
          resolve(checkout, squashForge([...files, collapsed], { additions: 7, deletions: 2 })),
        ),
      ).toEqual({ code: "change-source-mr-forge-incomplete", detail: "lines: 2+2 listed of 7+2" });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses an unknown diff shape on either arm, and omits a file over its own byte limit",
    async () => {
      const checkout = await emptyCheckout();
      for (const diff of [
        "diff --git a/docs/a.md b/docs/a.md\n@@ -0,0 +1 @@\n+line\n",
        "@@ -0,0 +1,2 @@\n+one line where two are counted\n",
        "@@ -0,0 +1 @@\n+no final newline",
        "Binary files a/docs/other.md and b/docs/other.md differ\n",
      ]) {
        const odd = diffItemOf({
          diff,
          oldPath: "docs/a.md",
          newPath: "docs/a.md",
          aMode: "0",
          bMode: "100644",
          newFile: true,
        });
        expect(await refusal(resolve(checkout, openForge([odd], "1"))), diff).toEqual({
          code: "change-source-mr-forge-incomplete",
          detail: "diff of A file",
        });
        expect(
          await refusal(resolve(checkout, squashForge([odd], { additions: 1, deletions: 0 }))),
          diff,
        ).toEqual({ code: "change-source-mr-forge-incomplete", detail: "diff of A file" });
      }
      const resolved = await resolve(checkout, openForge([added("docs/a.md", 3)], "1"));
      const size = resolved.diffBytes.byteLength;
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", size - 1);
      const omitted = await resolve(checkout, openForge([added("docs/a.md", 3)], "1"));
      expect(omitted.changeSource.files[0]!.diffOmitted).toEqual({
        code: "change-source-file-diff-omitted",
        observedBytes: size,
        basis: "measured",
        limitName: "changeSources.fileDiffMaxBytes",
        limitBytes: size - 1,
      });
      expect(omitted.changeSource.files[0]).toMatchObject({ added: 3, removed: 0 });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a page over the glab read bound as its own code, and keeps a timeout a transport failure",
    async () => {
      const checkout = await emptyCheckout();
      const bounded = openForge([added("docs/a.md")], "1").on(ENDPOINTS.diffs(1), {
        result: { stdout: "[", stderr: "", exitCode: 1, failure: "output-limit" },
      });
      expect(await refusal(resolve(checkout, bounded))).toEqual({
        code: "change-source-mr-forge-page-bound",
        detail: "diffs",
      });
      const slow = openForge([added("docs/a.md")], "1").on(ENDPOINTS.diffs(1), {
        result: { stdout: "", stderr: "", exitCode: 1, failure: "timeout" },
      });
      expect(await refusal(resolve(checkout, slow))).toEqual({
        code: "change-source-mr-objects-unavailable",
        detail: "base; GitLab read failed: timeout",
      });
      const expired = openForge([added("docs/a.md")], "1").on(ENDPOINTS.diffs(1), LOGIN_EXPIRED);
      expect(await refusal(resolve(checkout, expired))).toEqual({
        code: "change-source-mr-objects-unavailable",
        detail: "base; GitLab read failed: authentication",
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "takes the object format from the pinned ids' width, never a fixed one",
    async () => {
      const checkout = await emptyCheckout("sha256");
      const wide = { base: "b".repeat(64), head: "c".repeat(64) };
      const resolved = await resolve(checkout, openForge([added("docs/a.md")], "1", wide));
      expect(resolved.changeSource.objectFormat).toBe("sha256");
      expect(resolved.changeSource.revision.head).toBe(wide.head);
    },
    testTimeoutMs(60_000),
  );
});

describe("a diff item's flags, paths and modes must describe one change", () => {
  const MODIFY = "@@ -1 +1 @@\n-old\n+new\n";
  const CREATE = "@@ -0,0 +1 @@\n+line\n";
  const REMOVE = "@@ -1 +0,0 @@\n-line\n";
  type Item = Parameters<typeof diffItemOf>[0];
  const item = (fields: Omit<Item, "oldPath"> & { readonly oldPath?: string }): Item => ({
    oldPath: fields.newPath,
    ...fields,
  });

  // Each refused item sits beside an admitted one a single field away.
  const rows: readonly {
    readonly name: string;
    readonly refused: Item;
    readonly admitted: Item;
    readonly detail: string;
    readonly status: string;
  }[] = [
    {
      name: "added and renamed at once",
      refused: item({
        diff: CREATE,
        newPath: "a.md",
        aMode: "0",
        bMode: "100644",
        newFile: true,
        renamedFile: true,
      }),
      admitted: item({
        diff: CREATE,
        newPath: "a.md",
        aMode: "0",
        bMode: "100644",
        newFile: true,
      }),
      detail: "diff item status",
      status: "A",
    },
    {
      name: "two paths on an item not marked renamed",
      refused: item({
        diff: MODIFY,
        oldPath: "a.md",
        newPath: "b.md",
        aMode: "100644",
        bMode: "100644",
      }),
      admitted: item({
        diff: MODIFY,
        oldPath: "a.md",
        newPath: "b.md",
        aMode: "100644",
        bMode: "100644",
        renamedFile: true,
      }),
      detail: "diff item paths",
      status: "R",
    },
    {
      name: "two paths on an added file",
      refused: item({
        diff: CREATE,
        oldPath: "a.md",
        newPath: "b.md",
        aMode: "0",
        bMode: "100644",
        newFile: true,
      }),
      admitted: item({
        diff: CREATE,
        oldPath: "b.md",
        newPath: "b.md",
        aMode: "0",
        bMode: "100644",
        newFile: true,
      }),
      detail: "diff item paths",
      status: "A",
    },
    {
      name: "an added file with an old mode",
      refused: item({
        diff: CREATE,
        newPath: "a.md",
        aMode: "100644",
        bMode: "100644",
        newFile: true,
      }),
      admitted: item({
        diff: CREATE,
        newPath: "a.md",
        aMode: "0",
        bMode: "100644",
        newFile: true,
      }),
      detail: "diff item modes",
      status: "A",
    },
    {
      name: "a deleted file with a new mode",
      refused: item({
        diff: REMOVE,
        newPath: "a.md",
        aMode: "100644",
        bMode: "100644",
        deletedFile: true,
      }),
      admitted: item({
        diff: REMOVE,
        newPath: "a.md",
        aMode: "100644",
        bMode: "0",
        deletedFile: true,
      }),
      detail: "diff item modes",
      status: "D",
    },
    {
      name: "an absent new side on a file not marked deleted",
      refused: item({
        diff: REMOVE,
        newPath: "a.md",
        aMode: "100644",
        bMode: "0",
      }),
      admitted: item({
        diff: REMOVE,
        newPath: "a.md",
        aMode: "100644",
        bMode: "0",
        deletedFile: true,
      }),
      detail: "diff item modes",
      status: "D",
    },
  ];

  /** The item on both arms: `/diffs` with a count of one, and a squash commit with the hunk's totals. */
  async function onBothArms(fields: Item) {
    const checkout = await emptyCheckout();
    const lines = fields.diff.split("\n");
    const stats = {
      additions: lines.filter((line) => line.startsWith("+")).length,
      deletions: lines.filter((line) => line.startsWith("-")).length,
    };
    return Promise.all([
      refusal(resolve(checkout, openForge([diffItemOf(fields)], "1"))),
      resolve(checkout, squashForge([diffItemOf(fields)], stats)).then(
        (resolved) => resolved.changeSource.files.map((file) => file.status),
        (error: { code?: string; detail?: string }) => ({
          code: error.code,
          detail: error.detail,
        }),
      ),
    ]);
  }

  it(
    "refuses an item whose flags, paths or modes disagree, and admits the item one field away",
    async () => {
      for (const row of rows) {
        const [openRefused, squashRefused] = await onBothArms(row.refused);
        const refused = { code: "change-source-mr-forge-incomplete", detail: row.detail };
        expect(openRefused, row.name).toEqual(refused);
        expect(squashRefused, row.name).toEqual(refused);
        const [openAdmitted, squashAdmitted] = await onBothArms(row.admitted);
        expect(openAdmitted, row.name).toEqual({ code: "admitted" });
        expect(squashAdmitted, row.name).toEqual([row.status]);
      }
    },
    testTimeoutMs(60_000),
  );
});

describe("routing: only a missing object sends the diff to GitLab", () => {
  it(
    "routes blobless and treeless partial clones to GitLab without a fetch, on the selector's host",
    async () => {
      const ids = await mergeRequestRepository();
      const pin = mergeRequestGet({
        base: ids.base,
        start: ids.base,
        head: ids.second,
        merge: ids.merge,
      });
      for (const filter of ["blob:none", "tree:0"] as const) {
        const clone = await partialClone(ids.repository, filter);
        const gitlab = await commitForge(ids.repository, pin, ids.merge);
        const git: string[][] = [];
        const status: string[] = [];
        const resolved = await resolve(clone, gitlab, {
          observeGit: (args) => git.push([...args]),
          onStatus: (line) => status.push(line),
        });
        expect(source(resolved.changeSource).provenance, filter).toBe("forge-reported");
        expect(git.flat(), filter).not.toContain("fetch");
        expect(gitlab.endpoints(), filter).toEqual([
          ENDPOINTS.pin,
          ENDPOINTS.commit(ids.merge),
          ENDPOINTS.commitDiff(ids.merge, 1),
          ENDPOINTS.reread,
        ]);
        expect(
          gitlab.calls.map((args) => args[2]),
          filter,
        ).toEqual(gitlab.calls.map(() => FORGE_HOST));
        const what = filter === "blob:none" ? "file blob" : "tree";
        expect(status, filter).toContain(
          FORGE_LINE(`${what} in a partial clone; sides ${ids.base} then ${ids.merge}`),
        );
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "reaches GitLab for an unresolvable parent behind a present merge commit, and says why",
    async () => {
      const ids = await mergeRequestRepository();
      const pin = mergeRequestGet({
        base: ids.base,
        start: ids.base,
        head: ids.second,
        merge: ids.merge,
      });
      // GitLab's answers are recorded while the history is intact.
      const gitlab = await commitForge(ids.repository, pin, ids.merge);
      // The merge commit stays; the first parent its diff reads is gone.
      await rm(join(ids.repository, ".git", "objects", ids.base.slice(0, 2), ids.base.slice(2)));
      const status: string[] = [];
      const resolved = await resolve(ids.repository, gitlab, {
        onStatus: (line) => status.push(line),
      });
      expect(source(resolved.changeSource).provenance).toBe("forge-reported");
      expect(status).toContain(FORGE_LINE("commit history, change-source-revision-unresolved"));
    },
    testTimeoutMs(60_000),
  );

  it(
    "keeps damage, a full clone's missing blob, a git failure and a local bound as themselves, reading nothing from GitLab",
    async () => {
      // A tampered interior commit is damage.
      const tampered = await mergeRequestRepository();
      await rewriteLooseObject(tampered.repository, tampered.first, (body) =>
        Buffer.from(body.toString("latin1").replace("Edit the guide", "EDIT THE GUIDE"), "latin1"),
      );
      const openPin = (ids: { base: string; second: string }) =>
        mergeRequestGet(
          { base: ids.base, start: ids.base, head: ids.second, merge: null },
          { state: "opened", merged_at: null },
        );
      const integrity = await diffsForge(tampered.repository, openPin(tampered), tampered.base, [
        tampered.second,
        tampered.first,
      ]);
      expect((await refusal(resolve(tampered.repository, integrity))).code).toBe(
        "change-source-integrity-mismatch",
      );
      expect(integrity.endpoints()).toEqual([ENDPOINTS.pin]);

      // A full clone missing one changed blob is damage too.
      const damaged = await mergeRequestRepository();
      const blob = (
        await gitBytes(damaged.repository, ["rev-parse", `${damaged.merge}:docs/new.md`])
      )
        .toString()
        .trim();
      const mergedPin = mergeRequestGet({
        base: damaged.base,
        start: damaged.base,
        head: damaged.second,
        merge: damaged.merge,
      });
      const gitlab = await commitForge(damaged.repository, mergedPin, damaged.merge);
      await rm(join(damaged.repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      expect((await refusal(resolve(damaged.repository, gitlab))).code).toBe(
        "change-source-git-failed",
      );
      expect(gitlab.endpoints()).toEqual([ENDPOINTS.pin]);

      // A local commit bound refuses as that bound.
      const bounded = await mergeRequestRepository();
      const local = await diffsForge(bounded.repository, openPin(bounded), bounded.base, [
        bounded.second,
        bounded.first,
      ]);
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 1);
      const error = await resolve(bounded.repository, local).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "change-source-commits-bound", observed: 2 });
      expect(local.endpoints()).toEqual([ENDPOINTS.pin]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "keeps a GitLab read failure the local refusal, naming both causes",
    async () => {
      const ids = await mergeRequestRepository();
      const checkout = await checkoutWithout(ids.repository, ids.base);
      const pin = mergeRequestGet(
        { base: ids.base, start: ids.base, head: ids.second, merge: null },
        { squash_commit_sha: ids.squash, squash: true },
      );
      const gitlab = (await commitForge(ids.repository, pin, ids.squash)).on(
        ENDPOINTS.commit(ids.squash),
        LOGIN_EXPIRED,
      );
      const error = await resolve(checkout, gitlab).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect(error).toMatchObject({
        code: "change-source-mr-objects-unavailable",
        detail: "squash commit; GitLab read failed: authentication",
      });
      // The second read of the merge request fails the same way.
      const reread = (await commitForge(ids.repository, pin, ids.squash)).on(
        ENDPOINTS.reread,
        LOGIN_EXPIRED,
      );
      expect(await refusal(resolve(checkout, reread))).toEqual({
        code: "change-source-mr-objects-unavailable",
        detail: "squash commit; GitLab read failed: authentication",
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits a capped changed-file count when the objects are local: only the forge arm reads it",
    async () => {
      const ids = await mergeRequestRepository();
      const pin = mergeRequestGet(
        { base: ids.base, start: ids.base, head: ids.second, merge: null },
        { state: "opened", merged_at: null, changes_count: "1000+" },
      );
      const gitlab = new RecordedGitLab().on(ENDPOINTS.pin, pin);
      const resolved = await resolve(ids.repository, gitlab);
      expect(source(resolved.changeSource).provenance).toBe("local-verified");
      expect(gitlab.endpoints()).toEqual([ENDPOINTS.pin]);
    },
    testTimeoutMs(60_000),
  );
});

describe("the forge arm's text screens", () => {
  it(
    "refuses a configured credential in GitLab's diff text, and admits credential-shaped look-alikes",
    async () => {
      const checkout = await emptyCheckout();
      const withLine = (line: string) =>
        openForge(
          [
            diffItemOf({
              diff: `@@ -0,0 +1 @@\n+${line}\n`,
              oldPath: "docs/a.md",
              newPath: "docs/a.md",
              aMode: "0",
              bMode: "100644",
              newFile: true,
            }),
          ],
          "1",
        );
      const token = configureCredential(["glpat", "Hn3Kp8Ws2Zx6Qd4Vb7Lm9Rt"].join("-"));
      expect(await refusal(resolve(checkout, withLine(`token: ${token}`)))).toEqual({
        code: "change-source-credential-present",
      });
      const documentationKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
      const placeholder = ["glpat", "x".repeat(20)].join("-");
      for (const line of [
        `Set AWS_ACCESS_KEY_ID=${documentationKey} in the example.`,
        `export GITLAB_TOKEN=${placeholder}`,
      ]) {
        expect((await resolve(checkout, withLine(line))).changeSource.files, line).toHaveLength(1);
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "omits only the file whose diff text holds U+FFFD, and refuses it in a path or a subject",
    async () => {
      const checkout = await emptyCheckout();
      const replaced = diffItemOf({
        diff: "@@ -0,0 +1 @@\n+caf\uFFFD\n",
        oldPath: "docs/latin1.md",
        newPath: "docs/latin1.md",
        aMode: "0",
        bMode: "100644",
        newFile: true,
      });
      const resolved = await resolve(checkout, openForge([added("docs/a.md"), replaced], "2"));
      expect(
        resolved.changeSource.files.map((file) => [file.newPath, file.diffOmitted ?? null]),
      ).toEqual([
        ["docs/a.md", null],
        [
          "docs/latin1.md",
          {
            code: "change-source-file-diff-omitted",
            basis: "forge-omitted",
            forgeReason: "text-replaced",
          },
        ],
      ]);
      expect(text(resolved)).not.toContain("\uFFFD");
      expect(text(resolved)).toContain("diff --git a/docs/a.md b/docs/a.md");
      // GitLab did send this diff, so the status line says its text was replaced.
      const status: string[] = [];
      await resolveCliChangeSource({
        workspace: {
          path: checkout,
          sourcePath: checkout,
          requestedRevision: "HEAD",
          revision: await fixtureGit(checkout, ["rev-parse", "HEAD"]),
          dispose: async () => undefined,
        },
        selector: parseChangeSourceSelector(MR_URL),
        forge: openForge([added("docs/a.md"), replaced], "2").access(),
        onStatus: (line) => status.push(line),
      });
      expect(status.filter((line) => line.startsWith("change-source-file-diff-omitted"))).toEqual([
        "change-source-file-diff-omitted: docs/latin1.md diff from the forge holds replaced text (text-replaced); it stays listed in the change manifest without its diff",
      ]);
      // A lone surrogate has no UTF-8 form, so it is replaced text too.
      const lone = diffItemOf({
        diff: "@@ -0,0 +1 @@\n+caf\uD800\n",
        oldPath: "docs/lone.md",
        newPath: "docs/lone.md",
        aMode: "0",
        bMode: "100644",
        newFile: true,
      });
      expect(
        (await resolve(checkout, openForge([lone], "1"))).changeSource.files[0]!.diffOmitted,
      ).toMatchObject({ forgeReason: "text-replaced" });

      const pathReplaced = added("docs/caf\uFFFD.md");
      expect(await refusal(resolve(checkout, openForge([pathReplaced], "1")))).toEqual({
        code: "change-source-mr-forge-text-replaced",
        detail: "diff item old_path",
      });
      const subjectForge = openForge([added("docs/a.md")], "1").on(
        ENDPOINTS.commits(BASE, HEAD, 1),
        [commitsItemOf({ id: HEAD, parents: [BASE], message: "Caf\uFFFD notes\n\nbody\n" })],
      );
      expect(await refusal(resolve(checkout, subjectForge))).toEqual({
        code: "change-source-mr-forge-text-replaced",
        detail: "commit subject",
      });
      // Adjacent: U+FFFD past the subject line is not recorded, so it admits.
      const bodyOnly = openForge([added("docs/a.md")], "1").on(ENDPOINTS.commits(BASE, HEAD, 1), [
        commitsItemOf({ id: HEAD, parents: [BASE], message: "Notes\n\ncaf\uFFFD\n" }),
      ]);
      expect((await resolve(checkout, bodyOnly)).changeSource.commits[0]!.subject).toBe("Notes");
    },
    testTimeoutMs(60_000),
  );
});
