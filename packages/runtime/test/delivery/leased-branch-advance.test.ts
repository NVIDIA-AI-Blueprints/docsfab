// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { limit } from "../../src/config/limits.js";
import {
  buildRunPublicationMetadata,
  createCompositionPublicationBinding,
  DeliveryWorktreeError,
  DeterministicLocalGitPublisher,
  GitLabPublisherAdapterError,
  GitPublisherError,
  hasExactDocsFabPublicationMetadata,
  LocalUserGitLabPublisherAdapter,
  LocalUserGitLabPublisherError,
  LocalUserPublicationPreflightError,
  localUserPublicationPlanSha256,
  scmDeliveryIdempotencyKey,
  scmDeliveryIdentityKey,
  type GitLabPublisherCommandRunner,
  type LocalUserPublicationAdvanceV1,
  type LocalUserPublicationPlan,
  type LocalUserPublicationPlanV3,
  type VerifiedPublicationRun,
} from "../../src/delivery/index.js";
import {
  RUN_DELIVERY_ATTEMPT_LOCATIONS,
  type RunDeliveryAttemptLocation,
} from "../../src/delivery/run-deletion-adapter.js";
import { deliveryCapsuleName } from "../../src/delivery/worktree/materialize.js";
import {
  advanceFrom,
  bareHead,
  commitOn,
  createAdvanceFixture,
  git,
  PRODUCT_SAFE_CONFIG,
  PROJECT_ID,
  publish,
  publishRoot,
  receiptSnapshot,
  receiptStore,
  REMOTE_URL,
  removeAdvanceFixture,
  USERNAME,
  writeRun,
  type AdvanceFixture,
  type Published,
} from "./helpers/advance-fixture.js";

let fixture: AdvanceFixture | undefined;

afterEach(async () => {
  for (const name of [
    "DOCSFAB_DELIVERY_GIT_PUSH_TIMEOUT_MS",
    "DOCSFAB_DELIVERY_GIT_COMMIT_TIMEOUT_MS",
    "DOCSFAB_DELIVERY_GIT_LS_REMOTE_TIMEOUT_MS",
  ]) {
    delete process.env[name];
  }
  await removeAdvanceFixture(fixture);
  fixture = undefined;
});

/** Real git, real validation, and two publications per case. */
const SLOW = 180_000;

class Crash extends Error {}

async function rooted(options: { fileStore?: boolean } = {}): Promise<{
  f: AdvanceFixture;
  parent: Published;
  branch: string;
}> {
  fixture = await createAdvanceFixture(options);
  const run = await writeRun(fixture, "run-parent", fixture.base, "README.md", "one\n");
  const parent = await publishRoot(fixture, run);
  return { f: fixture, parent, branch: parent.plan.proposedSourceBranch };
}

async function failure(action: () => Promise<unknown>): Promise<{ name: string; code: string }> {
  try {
    await action();
  } catch (error) {
    if (
      error instanceof LocalUserPublicationPreflightError ||
      error instanceof LocalUserGitLabPublisherError ||
      error instanceof DeliveryWorktreeError ||
      error instanceof GitLabPublisherAdapterError ||
      error instanceof GitPublisherError
    ) {
      return { name: error.name, code: error.code };
    }
    throw error;
  }
  throw new Error("expected a coded failure");
}

interface WriteState {
  receipts: string[];
  pushes: number;
  writes: number;
  head: string | undefined;
}

async function writeState(f: AdvanceFixture, branch: string): Promise<WriteState> {
  return {
    receipts: await receiptSnapshot(f),
    pushes: f.git.pushes().length,
    writes: f.gitlab.writeCount,
    head: await bareHead(f.bare, branch),
  };
}

async function childAt(f: AdvanceFixture, head: string, runId = "run-child") {
  return writeRun(f, runId, head, "guide.md", `revision of ${runId}\n`);
}

async function childReceipt(f: AdvanceFixture, plan: LocalUserPublicationPlan) {
  return receiptStore(f).load(scmDeliveryIdempotencyKey(plan));
}

/** The plan the CLI stored for `run`, found by the receipt it claimed. */
async function storedPlanFor(f: AdvanceFixture, runId: string): Promise<LocalUserPublicationPlan> {
  for (const bytes of f.store!.plans.values()) {
    const plan = JSON.parse(bytes) as LocalUserPublicationPlan;
    if (plan.run.id === runId) return plan;
  }
  throw new Error(`no stored plan for ${runId}`);
}

describe("leased branch advance: the journey", () => {
  it(
    "adds one commit on the observed head under an observed-head lease and keeps the MR",
    async () => {
      const { f, parent, branch } = await rooted({ fileStore: true });
      // Positive control: the first publication still creates its branch
      // under an empty lease.
      const rootPush = f.git.pushes().at(-1)!;
      expect(rootPush.operation.slice(-3)).toEqual([
        `--force-with-lease=refs/heads/${branch}:`,
        REMOTE_URL,
        `${parent.head}:refs/heads/${branch}`,
      ]);
      expect(parent.receipt.schemaVersion).toBe(2);
      expect("advance" in parent.receipt).toBe(false);
      const mergeRequest = f.gitlab.mergeRequests.get(17)!;
      const descriptionBefore = mergeRequest.description;
      const titleBefore = mergeRequest.title;
      const child = await childAt(f, parent.head);
      const pushesBefore = f.git.pushes().length;
      const { plan } = await publish(f, child, { advance: advanceFrom(parent, parent.head) });
      expect(plan).toMatchObject({
        schemaVersion: 3,
        baseRevision: parent.head,
        proposedSourceBranch: branch,
        identity: { gitlabUsername: USERNAME, gitlabUserId: 7 },
        checks: { revision: "descends-from-recorded-head" },
      });
      const receipt = await childReceipt(f, plan!);
      expect(receipt).toMatchObject({
        schemaVersion: 3,
        state: "opened",
        disposition: "succeeded",
        sourceBranch: branch,
        advance: {
          parentReceiptSha256: parent.receipt.sha256,
          previousHead: parent.head,
          parentIdempotencyKey: parent.receipt.idempotencyKey,
          ordinal: 1,
          mergeRequestIid: 17,
        },
        evidence: { mergeRequest: { iid: 17 } },
      });
      const commit = receipt!.evidence.commit!.sha;
      expect(await bareHead(f.bare, branch)).toBe(commit);
      const parents = (await git(f.bare, "cat-file", "-p", commit))
        .split("\n")
        .filter((line) => line.startsWith("parent "));
      expect(parents).toEqual([`parent ${parent.head}`]);
      expect(f.gitlab.createCount).toBe(1);
      expect(f.gitlab.mergeRequests.size).toBe(1);
      expect(f.gitlab.mergeRequests.get(17)!.description).toBe(descriptionBefore);
      expect(f.gitlab.mergeRequests.get(17)!.title).toBe(titleBefore);
      const pushes = f.git.pushes().slice(pushesBefore);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.operation.slice(-3)).toEqual([
        `--force-with-lease=refs/heads/${branch}:${parent.head}`,
        REMOTE_URL,
        `${commit}:refs/heads/${branch}`,
      ]);
      expect(pushes[0]!.raw.slice(0, PRODUCT_SAFE_CONFIG.length)).toEqual([...PRODUCT_SAFE_CONFIG]);
      expect(pushes[0]!.timeoutMs).toBe(limit("delivery.gitPushTimeoutMs").value);
      const commitTree = f.git.calls.filter((call) => call.operation[0] === "commit-tree");
      expect(commitTree.at(-1)!.timeoutMs).toBe(limit("delivery.gitCommitTimeoutMs").value);
      const lsRemote = f.git.calls.filter((call) => call.operation[0] === "ls-remote");
      expect(lsRemote.at(-1)!.timeoutMs).toBe(limit("delivery.gitLsRemoteTimeoutMs").value);
    },
    SLOW,
  );

  it(
    "chains a second revision from the first and keeps a human commit as the parent",
    async () => {
      const { f, parent, branch } = await rooted();
      const human = await commitOn(f, parent.head, "human.md", "reviewer note\n");
      await git(f.source, "push", "--quiet", f.bare, `${human}:refs/heads/${branch}`);
      const first = await publishRoot(f, await childAt(f, human, "run-child-1"), {
        advance: advanceFrom(parent, human),
      });
      const firstParents = (await git(f.bare, "cat-file", "-p", first.head))
        .split("\n")
        .filter((line) => line.startsWith("parent "));
      expect(firstParents).toEqual([`parent ${human}`]);
      expect(await git(f.bare, "merge-base", "--is-ancestor", human, branch)).toBe("");
      const second = await publishRoot(f, await childAt(f, first.head, "run-child-2"), {
        advance: advanceFrom(first, first.head, 2),
      });
      expect(second.receipt).toMatchObject({
        schemaVersion: 3,
        state: "opened",
        advance: {
          parentReceiptSha256: first.receipt.sha256,
          previousHead: first.head,
          ordinal: 2,
          mergeRequestIid: 17,
        },
      });
      expect(await bareHead(f.bare, branch)).toBe(second.head);
      expect(f.gitlab.createCount).toBe(1);
    },
    SLOW,
  );
});

describe("leased branch advance: a concurrent push between observation and push", () => {
  it(
    "does not recreate a branch deleted before the push",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      f.git.beforePush = async () => {
        await git(f.bare, "update-ref", "-d", `refs/heads/${branch}`);
      };
      const result = await failure(() =>
        publish(f, child, { advance: advanceFrom(parent, parent.head) }),
      );
      expect(result).toEqual({ name: "LocalUserGitLabPublisherError", code: "push-failed" });
      expect(await bareHead(f.bare, branch)).toBeUndefined();
      expect(f.git.pushes().at(-1)!.operation).toContain(
        `--force-with-lease=refs/heads/${branch}:${parent.head}`,
      );
    },
    SLOW,
  );

  it(
    "leaves a branch that moved forward where it moved",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const moved = await commitOn(f, parent.head, "late.md", "late human push\n");
      await git(f.source, "push", "--quiet", f.bare, `${moved}:refs/heads/moved-forward`);
      f.git.beforePush = async () => {
        await git(f.bare, "update-ref", `refs/heads/${branch}`, moved);
      };
      const result = await failure(() =>
        publish(f, child, { advance: advanceFrom(parent, parent.head) }),
      );
      expect(result).toEqual({ name: "LocalUserGitLabPublisherError", code: "remote-drift" });
      expect(await bareHead(f.bare, branch)).toBe(moved);
      const receipt = await childReceipt(f, await storedPlanFor(f, "run-child"));
      const commit = receipt!.evidence.commit!.sha;
      expect(await git(f.bare, "rev-list", branch)).not.toContain(commit);
    },
    SLOW,
  );

  it(
    "refuses a fast-forward when the branch was reset back to the recorded head",
    async () => {
      const { f, parent, branch } = await rooted();
      const human = await commitOn(f, parent.head, "human.md", "reviewer note\n");
      await git(f.source, "push", "--quiet", f.bare, `${human}:refs/heads/${branch}`);
      const child = await childAt(f, human);
      f.git.beforePush = async () => {
        await git(f.bare, "update-ref", `refs/heads/${branch}`, parent.head);
      };
      const result = await failure(() =>
        publish(f, child, { advance: advanceFrom(parent, human) }),
      );
      expect(result).toEqual({ name: "LocalUserGitLabPublisherError", code: "remote-drift" });
      expect(await bareHead(f.bare, branch)).toBe(parent.head);
      const receipt = await childReceipt(f, await storedPlanFor(f, "run-child"));
      expect(receipt).toMatchObject({ state: "committed", disposition: "failed" });
      expect(await git(f.bare, "rev-list", branch)).not.toContain(receipt!.evidence.commit!.sha);
    },
    SLOW,
  );
});

describe("leased branch advance: refusals before any write", () => {
  it(
    "refuses each D2 condition and each mismatched parent field with its code",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const valid = advanceFrom(parent, parent.head);
      const before = await writeState(f, branch);
      const refuse = async (
        advance: LocalUserPublicationAdvanceV1,
        options: { targetBranch?: string } = {},
      ) => {
        const result = await failure(() => publish(f, child, { advance, ...options }));
        expect(await writeState(f, branch)).toEqual(before);
        return result;
      };
      const mergeRequest = f.gitlab.mergeRequests.get(17)!;
      const original = { ...mergeRequest };

      for (const state of ["closed", "merged"] as const) {
        mergeRequest.state = state;
        expect(await refuse(valid)).toEqual({
          name: "LocalUserPublicationPreflightError",
          code: "revision-mr-not-open",
        });
      }
      Object.assign(mergeRequest, original, {
        draft: false,
        title: original.title.replace(/^Draft: /u, ""),
      });
      const ready = await failure(() => publish(f, child, { advance: valid }));
      expect(ready.code).toBe("revision-mr-not-open");
      Object.assign(mergeRequest, original);

      f.gitlab.username = "someone-else";
      expect((await refuse(valid)).code).toBe("revision-requester-mismatch");
      f.gitlab.username = USERNAME;

      mergeRequest.description = original.description.replace(
        "docsfab-publication-provenance:v1 delivery=local-user",
        "docsfab-publication-provenance:v1 delivery=altered",
      );
      expect((await refuse(valid)).code).toBe("revision-root-marker-mismatch");
      Object.assign(mergeRequest, original);

      const fields: Array<[string, LocalUserPublicationAdvanceV1]> = [
        ["lastRecordedHead", { ...valid, lastRecordedHead: f.base }],
        ["sourceBranch", { ...valid, sourceBranch: `${branch}-other` }],
        ["projectId", { ...valid, mergeRequest: { projectId: PROJECT_ID + 1, iid: 17 } }],
        ["mergeRequestIid", { ...valid, mergeRequest: { projectId: PROJECT_ID, iid: 18 } }],
        ["ordinal", { ...valid, ordinal: 2 }],
        ["runId", { ...valid, parent: { ...valid.parent, runId: "run-other" } }],
        ["recordSha256", { ...valid, parent: { ...valid.parent, recordSha256: "1".repeat(64) } }],
        [
          "deliveryReceiptSha256",
          { ...valid, parent: { ...valid.parent, deliveryReceiptSha256: "2".repeat(64) } },
        ],
        ["planSha256", { ...valid, parent: { ...valid.parent, planSha256: "3".repeat(64) } }],
        [
          "idempotencyKey",
          { ...valid, parent: { ...valid.parent, idempotencyKey: "4".repeat(64) } },
        ],
        ["observedHead", { ...valid, observedHead: f.base }],
      ];
      for (const [field, advance] of fields) {
        const result = await failure(() => publish(f, child, { advance }));
        expect({ field, ...result }).toEqual({
          field,
          name: "LocalUserPublicationPreflightError",
          code: "revision-parent-mismatch",
        });
        expect(await writeState(f, branch)).toEqual(before);
      }
      expect((await refuse(valid, { targetBranch: "release" })).code).toBe(
        "revision-parent-mismatch",
      );

      // The branch moved after the child run started.
      const moved = await commitOn(f, parent.head, "late.md", "late\n");
      await git(f.source, "push", "--quiet", f.bare, `${moved}:refs/heads/${branch}`);
      const headMoved = await failure(() => publish(f, child, { advance: valid }));
      expect(headMoved.code).toBe("revision-head-moved");
      await git(f.bare, "update-ref", `refs/heads/${branch}`, parent.head);

      // A shallow checkout cannot prove ancestry.
      const shallow = join(f.source, ".git", "shallow");
      await writeFile(shallow, `${f.base}\n`);
      expect((await refuse(valid)).code).toBe("revision-shallow-repository");
      await rm(shallow);

      // The parent's run record is gone.
      const parentRecord = join(f.state, "run-parent.json");
      await rename(parentRecord, `${parentRecord}.moved`);
      expect((await refuse(valid)).code).toBe("revision-parent-record-unavailable");
      await rename(`${parentRecord}.moved`, parentRecord);

      // Positive control: the same child without an advance is stale against
      // the target, exactly as before.
      const stale = await failure(() => publish(f, child));
      expect(stale.code).toBe("stale-revision");

      // Every condition restored, the advance proceeds.
      await publish(f, child, { advance: valid });
      expect(await bareHead(f.bare, branch)).not.toBe(parent.head);
    },
    SLOW,
  );

  it(
    "refuses an advance without the receipt store that holds its parent",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const before = await writeState(f, branch);
      const elsewhere = join(f.root, "no-receipts");
      const result = await failure(() =>
        publish(f, child, {
          advance: advanceFrom(parent, parent.head),
          withoutStore: true,
          receiptRoot: elsewhere,
        }),
      );
      expect(result.code).toBe("revision-receipt-store-missing");
      expect(await writeState(f, branch)).toEqual(before);
      await expect(readFile(elsewhere)).rejects.toMatchObject({ code: "ENOENT" });
    },
    SLOW,
  );

  it(
    "refuses a rewritten branch, and a missing recorded head as its own condition",
    async () => {
      const { f, parent, branch } = await rooted();
      const rewritten = await commitOn(f, f.base, "rewrite.md", "force-pushed\n");
      await git(
        f.source,
        "push",
        "--quiet",
        "--force",
        f.bare,
        `${rewritten}:refs/heads/${branch}`,
      );
      const child = await childAt(f, rewritten);
      const advance = advanceFrom(parent, rewritten);
      const before = await writeState(f, branch);
      expect((await failure(() => publish(f, child, { advance }))).code).toBe(
        "revision-head-rewritten",
      );
      expect(await writeState(f, branch)).toEqual(before);

      // Drop every local reference to the recorded head, then prune it; the
      // rewritten head stays referenced, as a fetched MR head would be.
      await git(f.source, "update-ref", "refs/heads/fetched-mr-head", rewritten);
      for (const line of (await git(f.source, "worktree", "list", "--porcelain")).split("\n")) {
        if (line.startsWith("worktree ") && line.slice("worktree ".length) !== f.source) {
          await git(f.source, "worktree", "remove", "--force", line.slice("worktree ".length));
        }
      }
      await git(f.source, "update-ref", "-d", `refs/heads/${branch}`);
      await git(f.source, "reflog", "expire", "--expire=now", "--all");
      await git(f.source, "gc", "--quiet", "--prune=now");
      await expect(git(f.source, "cat-file", "-e", `${parent.head}^{commit}`)).rejects.toThrow();
      expect((await failure(() => publish(f, child, { advance }))).code).toBe(
        "revision-object-missing",
      );
      expect(await writeState(f, branch)).toEqual(before);
    },
    SLOW,
  );

  it(
    "refuses a local branch at an unrelated commit",
    async () => {
      const { f, parent, branch } = await rooted();
      const unrelated = await commitOn(f, f.base, "unrelated.md", "unrelated\n");
      await git(f.source, "update-ref", `refs/heads/${branch}`, unrelated);
      const child = await childAt(f, parent.head);
      const result = await failure(() =>
        publish(f, child, { advance: advanceFrom(parent, parent.head) }),
      );
      expect(result).toEqual({ name: "DeliveryWorktreeError", code: "delivery-collision" });
      expect(f.git.pushes()).toHaveLength(1);
      expect(await git(f.source, "rev-parse", `refs/heads/${branch}`)).toBe(unrelated);
    },
    SLOW,
  );

  it(
    "refuses a stored plan whose advance differs from the typed request",
    async () => {
      const { f, parent } = await rooted();
      const child = await childAt(f, parent.head);
      const advance = advanceFrom(parent, parent.head);
      const { plan } = await publish(f, child, { advance });
      const result = await failure(() =>
        publish(f, child, { advance: { ...advance, ordinal: 2 }, confirm: plan!.sha256 }),
      );
      expect(result.code).toBe("revision-parent-mismatch");
    },
    SLOW,
  );
});

describe("leased branch advance: the MR is re-read at publish time", () => {
  it(
    "stops before the commit when the MR was merged, closed, or undrafted after preflight",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const advance = advanceFrom(parent, parent.head);
      f.gitlab.listState = { state: "merged" };
      const merged = await failure(() => publish(f, child, { advance }));
      expect(merged.code).toBe("revision-mr-not-open");
      const plan = await storedPlanFor(f, "run-child");
      const localBefore = await git(f.source, "rev-parse", `refs/heads/${branch}`);
      const title = f.gitlab.mergeRequests.get(17)!.title.replace(/^Draft: /u, "");
      for (const listState of [{ state: "closed" as const }, { draft: false, title }]) {
        f.gitlab.listState = listState;
        const again = await failure(() => publish(f, child, { advance, confirm: plan.sha256 }));
        expect(again.code).toBe("revision-mr-not-open");
      }
      // The root marker is re-checked too: an MR altered after preflight is
      // not reused, and nothing is committed or pushed.
      const description = f.gitlab.mergeRequests
        .get(17)!
        .description.replace("delivery=local-user", "delivery=altered");
      f.gitlab.listState = { description };
      const altered = await failure(() => publish(f, child, { advance, confirm: plan.sha256 }));
      expect(altered.code).toBe("merge-request-changed");
      expect(f.git.pushes()).toHaveLength(1);
      expect(f.git.calls.filter((call) => call.operation[0] === "commit-tree")).toHaveLength(1);
      expect(await git(f.source, "rev-parse", `refs/heads/${branch}`)).toBe(localBefore);
      expect(await childReceipt(f, plan)).toMatchObject({
        state: "validated",
        disposition: "failed",
        failure: { code: "merge-request-changed" },
      });
      // Crash matrix, validated: once the MR is an open draft again the retry
      // commits and pushes exactly once.
      f.gitlab.listState = undefined;
      await publish(f, child, { advance, confirm: plan.sha256 });
      expect(f.git.pushes()).toHaveLength(2);
      expect(await childReceipt(f, plan)).toMatchObject({ state: "opened" });
    },
    SLOW,
  );
});

describe("leased branch advance: a retry after a crash never pushes twice", () => {
  it(
    "does not adopt a discovered legacy attempt when the recorded attempt root is empty",
    async () => {
      const { f, parent, branch } = await rooted();
      const marker = join(f.root, "fail-validation-once");
      const validationScript = `const fs = require("node:fs"); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(1);\n`;
      const human = await commitOn(f, parent.head, "validate.cjs", validationScript);
      await git(f.source, "push", "--quiet", f.bare, `${human}:refs/heads/${branch}`);
      const child = await childAt(f, human);
      const advance = advanceFrom(parent, human);
      await writeFile(marker, "fail validation before retained replay\n");

      await expect(publish(f, child, { advance })).rejects.toMatchObject({
        name: "DeliveryWorktreeError",
        code: "validation-failed",
      });
      const plan = await storedPlanFor(f, child.runId);
      const locations = await readdir(join(f.state, RUN_DELIVERY_ATTEMPT_LOCATIONS));
      const recorded = (
        await Promise.all(
          locations.map(async (name) =>
            JSON.parse(await readFile(join(f.state, RUN_DELIVERY_ATTEMPT_LOCATIONS, name), "utf8")),
          ),
        )
      ).find(
        (location: RunDeliveryAttemptLocation) =>
          location.runId === child.runId && location.planSha256 === plan.sha256,
      ) as RunDeliveryAttemptLocation | undefined;
      expect(recorded).toBeDefined();

      const recordedWorktree = join(recorded!.attemptPath, deliveryCapsuleName(plan), "repository");
      const legacyAttemptRoot = join(f.deliveries, "attempts", "legacy-valid");
      const legacyCapsule = join(legacyAttemptRoot, deliveryCapsuleName(plan));
      const legacyWorktree = join(legacyCapsule, "repository");
      await mkdir(legacyCapsule, { recursive: true, mode: 0o700 });
      await copyFile(
        join(recorded!.attemptPath, deliveryCapsuleName(plan), "verified.patch"),
        join(legacyCapsule, "verified.patch"),
      );
      await git(f.source, "worktree", "add", "--detach", "--quiet", legacyWorktree, human);
      const legacyHeadBefore = await git(legacyWorktree, "rev-parse", "HEAD");
      const legacyIndexBefore = await git(legacyWorktree, "write-tree");
      const legacyDiffBefore = await git(legacyWorktree, "diff", "--binary", "HEAD");
      const legacyUntrackedBefore = await git(
        legacyWorktree,
        "ls-files",
        "--others",
        "--exclude-standard",
      );
      await git(f.source, "worktree", "remove", "--force", recordedWorktree);
      await rm(recorded!.attemptPath, { recursive: true, force: true });
      await mkdir(recorded!.attemptPath, { mode: 0o700 });
      await rm(marker);

      await publish(f, child, { advance, confirm: plan.sha256 });

      const refreshedLocations = await readdir(join(f.state, RUN_DELIVERY_ATTEMPT_LOCATIONS));
      const matchingLocations = (
        await Promise.all(
          refreshedLocations.map(async (name) =>
            JSON.parse(await readFile(join(f.state, RUN_DELIVERY_ATTEMPT_LOCATIONS, name), "utf8")),
          ),
        )
      ).filter(
        (location: RunDeliveryAttemptLocation) =>
          location.runId === child.runId && location.planSha256 === plan.sha256,
      ) as RunDeliveryAttemptLocation[];
      expect(matchingLocations).toHaveLength(1);
      expect(matchingLocations[0]!.attemptPath).toBe(recorded!.attemptPath);
      expect(await git(legacyWorktree, "rev-parse", "HEAD")).toBe(legacyHeadBefore);
      expect(await git(legacyWorktree, "write-tree")).toBe(legacyIndexBefore);
      expect(await git(legacyWorktree, "diff", "--binary", "HEAD")).toBe(legacyDiffBefore);
      expect(await git(legacyWorktree, "ls-files", "--others", "--exclude-standard")).toBe(
        legacyUntrackedBefore,
      );
    },
    SLOW,
  );

  it(
    "replays a retained human-commit advance while the local branch remains at its recorded head",
    async () => {
      const { f, parent, branch } = await rooted();
      const marker = join(f.root, "fail-validation-once");
      const validationScript = `const fs = require("node:fs"); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(1);\n`;
      const human = await commitOn(f, parent.head, "validate.cjs", validationScript);
      await git(f.source, "push", "--quiet", f.bare, `${human}:refs/heads/${branch}`);
      const child = await childAt(f, human);
      const advance = advanceFrom(parent, human);
      await writeFile(marker, "fail validation before retained replay\n");

      await expect(publish(f, child, { advance })).rejects.toMatchObject({
        name: "DeliveryWorktreeError",
        code: "validation-failed",
      });
      const plan = await storedPlanFor(f, child.runId);
      expect(plan).toMatchObject({
        baseRevision: human,
        advance: { lastRecordedHead: parent.head, observedHead: human },
      });
      const failed = await childReceipt(f, plan);
      expect(failed).toMatchObject({
        state: "prepared",
        disposition: "failed",
        advance: { previousHead: parent.head },
      });
      expect(await bareHead(f.bare, branch)).toBe(human);
      expect(await git(f.source, "rev-parse", `refs/heads/${branch}`)).toBe(parent.head);
      const locationFiles = await readdir(join(f.state, RUN_DELIVERY_ATTEMPT_LOCATIONS));
      const locations = await Promise.all(
        locationFiles.map(
          async (name) =>
            JSON.parse(
              await readFile(join(f.state, RUN_DELIVERY_ATTEMPT_LOCATIONS, name), "utf8"),
            ) as RunDeliveryAttemptLocation,
        ),
      );
      const retainedLocation = locations.find(
        (location) => location.runId === child.runId && location.planSha256 === plan.sha256,
      );
      expect(retainedLocation).toBeDefined();
      const retainedWorktree = join(
        retainedLocation!.attemptPath,
        deliveryCapsuleName(plan),
        "repository",
      );
      expect(await readdir(retainedWorktree)).toContain(".git");
      expect(await git(retainedWorktree, "rev-parse", "HEAD")).toBe(human);
      expect(await git(retainedWorktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");

      // A stale discovered capsule sorts before the exact recorded attempt.
      // Its mismatched HEAD must not mask the persisted run/plan location.
      const staleAttempt = join(f.deliveries, "attempts", "000-stale-first");
      const staleRepository = join(staleAttempt, deliveryCapsuleName(plan), "repository");
      const staleGitDirectory = join(staleRepository, ".git");
      await mkdir(staleGitDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(staleGitDirectory, "HEAD"), `${parent.head}\n`, { mode: 0o600 });

      await rm(marker);
      const attemptsBeforeReplay = await readdir(join(f.deliveries, "attempts"));
      const pushesBeforeReplay = f.git.pushes().length;
      await publish(f, child, { advance, confirm: plan.sha256 });
      const opened = await childReceipt(f, plan);
      expect(opened).toMatchObject({
        state: "opened",
        disposition: "succeeded",
        advance: { previousHead: parent.head },
      });
      expect(await bareHead(f.bare, branch)).toBe(opened!.evidence.push!.remoteRevision);
      expect(await readdir(join(f.deliveries, "attempts"))).toEqual(attemptsBeforeReplay);

      const receiptAttempts = opened!.attempts;
      const mergeWrites = f.gitlab.writeCount;
      const pushes = f.git.pushes().length;
      await publish(f, child, { advance, confirm: plan.sha256 });
      expect((await childReceipt(f, plan))!.attempts).toEqual(receiptAttempts);
      expect(await readdir(join(f.deliveries, "attempts"))).toEqual(attemptsBeforeReplay);
      expect(f.git.pushes()).toHaveLength(pushes);
      expect(f.gitlab.writeCount).toBe(mergeWrites);
      expect(pushes).toBe(pushesBeforeReplay + 1);
    },
    SLOW,
  );

  it(
    "adopts only the exact child when the committed receipt write fails",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const advance = advanceFrom(parent, parent.head);
      const store = f.store!;
      const compareAndSwap = store.compareAndSwap.bind(store);
      let interrupted = false;
      store.compareAndSwap = async (expected, record) => {
        if (record.run.id === child.runId && record.state === "committed" && !interrupted) {
          interrupted = true;
          throw new Crash();
        }
        return compareAndSwap(expected, record);
      };
      await expect(publish(f, child, { advance })).rejects.toThrow(Crash);
      const plan = await storedPlanFor(f, child.runId);
      const childCommit = await git(f.source, "rev-parse", `refs/heads/${branch}`);
      expect(await childReceipt(f, plan)).toMatchObject({
        state: "validated",
        disposition: "active",
      });
      expect(await bareHead(f.bare, branch)).toBe(parent.head);
      expect(f.git.pushes()).toHaveLength(1);

      store.compareAndSwap = compareAndSwap;
      await publish(f, child, { advance, confirm: plan.sha256 });
      expect(await bareHead(f.bare, branch)).toBe(childCommit);
      expect(await childReceipt(f, plan)).toMatchObject({ state: "opened" });
      expect(f.git.pushes()).toHaveLength(2);
      expect(f.gitlab.createCount).toBe(1);
      expect(f.git.calls.filter((call) => call.operation[0] === "commit-tree")).toHaveLength(2);
    },
    SLOW,
  );

  it(
    "refuses a different local commit after the committed receipt write fails",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const advance = advanceFrom(parent, parent.head);
      const store = f.store!;
      const compareAndSwap = store.compareAndSwap.bind(store);
      let interrupted = false;
      store.compareAndSwap = async (expected, record) => {
        if (record.run.id === child.runId && record.state === "committed" && !interrupted) {
          interrupted = true;
          throw new Crash();
        }
        return compareAndSwap(expected, record);
      };
      await expect(publish(f, child, { advance })).rejects.toThrow(Crash);
      const plan = await storedPlanFor(f, child.runId);
      store.compareAndSwap = compareAndSwap;
      const expectedCommit = await git(f.source, "rev-parse", `refs/heads/${branch}`);
      const tree = await git(f.source, "rev-parse", `${expectedCommit}^{tree}`);
      const foreign = await git(f.source, "commit-tree", tree, "-p", parent.head, "-m", "foreign");
      await git(f.source, "update-ref", `refs/heads/${branch}`, foreign, expectedCommit);

      expect(await failure(() => publish(f, child, { advance, confirm: plan.sha256 }))).toEqual({
        name: "DeliveryWorktreeError",
        code: "delivery-collision",
      });
      expect(await git(f.source, "rev-parse", `refs/heads/${branch}`)).toBe(foreign);
      expect(await bareHead(f.bare, branch)).toBe(parent.head);
      expect(f.git.pushes()).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "resumes from committed across a deleted, a moved, and an intact branch",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const advance = advanceFrom(parent, parent.head);
      const crash = () => {
        throw new Crash();
      };
      await expect(publish(f, child, { advance, hooks: { afterCommit: crash } })).rejects.toThrow(
        Crash,
      );
      const plan = (await storedPlanFor(f, "run-child")) as LocalUserPublicationPlanV3;
      const retry = () => publish(f, child, { advance, confirm: plan.sha256 });
      expect(await childReceipt(f, plan)).toMatchObject({ state: "committed" });
      const commit = (await childReceipt(f, plan))!.evidence.commit!.sha;
      const pushes = f.git.pushes().length;

      // committed, remote deleted.
      await git(f.bare, "update-ref", "-d", `refs/heads/${branch}`);
      expect((await failure(retry)).code).toBe("remote-branch-deleted");
      expect(f.git.pushes()).toHaveLength(pushes);
      await git(f.bare, "update-ref", `refs/heads/${branch}`, parent.head);

      // committed, remote elsewhere.
      const elsewhere = await commitOn(f, parent.head, "late.md", "late\n");
      await git(f.source, "push", "--quiet", f.bare, `${elsewhere}:refs/heads/${branch}`);
      expect((await failure(retry)).code).toBe("remote-drift");
      expect(f.git.pushes()).toHaveLength(pushes);
      // The publisher itself refuses to push over any head but the observed one.
      const publisher = new DeterministicLocalGitPublisher(f.git, {
        PATH: process.env.PATH,
        HOME: f.home,
      });
      expect(
        (await failure(() => publisher.ensurePush({ plan, commitRevision: commit, cwd: f.source })))
          .code,
      ).toBe("remote-branch-conflict");
      expect(f.git.pushes()).toHaveLength(pushes);
      await git(f.bare, "update-ref", `refs/heads/${branch}`, parent.head);

      // committed, remote at the observed head: exactly one push.
      await retry();
      expect(f.git.pushes()).toHaveLength(pushes + 1);
      expect(await bareHead(f.bare, branch)).toBe(commit);
      expect(await childReceipt(f, plan)).toMatchObject({ state: "opened" });

      // opened: reuse without a push or an MR write.
      const writes = f.gitlab.writeCount;
      await retry();
      expect(f.git.pushes()).toHaveLength(pushes + 1);
      expect(f.gitlab.writeCount).toBe(writes);

      // opened, MR head elsewhere: refused.
      f.gitlab.mergeRequests.get(17)!.sha = parent.head;
      expect((await failure(retry)).code).toBe("merge-request-changed");
      expect(f.git.pushes()).toHaveLength(pushes + 1);
    },
    SLOW,
  );

  it(
    "resumes from committed when the push landed before the crash",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const advance = advanceFrom(parent, parent.head);
      await expect(
        publish(f, child, {
          advance,
          hooks: {
            afterCommit: () => {
              throw new Crash();
            },
          },
        }),
      ).rejects.toThrow(Crash);
      const plan = await storedPlanFor(f, "run-child");
      const commit = (await childReceipt(f, plan))!.evidence.commit!.sha;
      await git(f.source, "push", "--quiet", f.bare, `${commit}:refs/heads/${branch}`);
      const pushes = f.git.pushes().length;
      await publish(f, child, { advance, confirm: plan.sha256 });
      expect(f.git.pushes()).toHaveLength(pushes);
      expect(await childReceipt(f, plan)).toMatchObject({ state: "opened" });
      expect(f.gitlab.createCount).toBe(1);
    },
    SLOW,
  );

  it(
    "resumes from pushed through a pending MR refresh and refuses a branch reset behind it",
    async () => {
      const { f, parent, branch } = await rooted();
      const child = await childAt(f, parent.head);
      const advance = advanceFrom(parent, parent.head);
      await expect(
        publish(f, child, {
          advance,
          hooks: {
            afterPush: () => {
              throw new Crash();
            },
          },
        }),
      ).rejects.toThrow(Crash);
      const plan = await storedPlanFor(f, "run-child");
      const retry = () => publish(f, child, { advance, confirm: plan.sha256 });
      const commit = (await childReceipt(f, plan))!.evidence.commit!.sha;
      const pushes = f.git.pushes().length;
      const mergeRequest = f.gitlab.mergeRequests.get(17)!;

      // pushed, GitLab has not refreshed the MR head yet: transient.
      mergeRequest.sha = parent.head;
      expect((await failure(retry)).code).toBe("merge-request-open-failed");
      expect(f.git.pushes()).toHaveLength(pushes);

      // pushed, remote reset behind the pushed commit: refused.
      await git(f.bare, "update-ref", `refs/heads/${branch}`, parent.head);
      expect((await failure(retry)).code).toBe("receipt-drift");
      expect(f.git.pushes()).toHaveLength(pushes);
      await git(f.bare, "update-ref", `refs/heads/${branch}`, commit);

      // pushed, MR refreshed: opened without a push or an MR write.
      mergeRequest.sha = undefined;
      await retry();
      expect(f.git.pushes()).toHaveLength(pushes);
      expect(f.gitlab.createCount).toBe(1);
      expect(await childReceipt(f, plan)).toMatchObject({ state: "opened" });
    },
    SLOW,
  );

  it(
    "keeps the first publication's refusals for a foreign remote and a foreign MR head",
    async () => {
      fixture = await createAdvanceFixture();
      const f = fixture;
      const run = await writeRun(f, "run-parent", f.base, "README.md", "one\n");
      await expect(
        publish(f, run, {
          hooks: {
            afterMergeRequest: () => {
              throw new Crash();
            },
          },
        }),
      ).rejects.toThrow(Crash);
      const plan = await storedPlanFor(f, "run-parent");
      const retry = () => publish(f, run, { confirm: plan.sha256 });
      const mergeRequest = f.gitlab.mergeRequests.get(17)!;
      mergeRequest.sha = f.base;
      expect((await failure(retry)).code).toBe("merge-request-changed");
      const head = (await bareHead(f.bare, plan.proposedSourceBranch))!;
      mergeRequest.sha = head;
      await git(f.bare, "update-ref", `refs/heads/${plan.proposedSourceBranch}`, f.base);
      expect((await failure(retry)).code).toBe("remote-drift");
      mergeRequest.sha = undefined;
      await git(f.bare, "update-ref", `refs/heads/${plan.proposedSourceBranch}`, head);
      await retry();
    },
    SLOW,
  );
});

describe("leased branch advance: limits", () => {
  it(
    "reads each git timeout from its limit, and an override lowers it",
    async () => {
      const { f, parent, branch } = await rooted();
      process.env.DOCSFAB_DELIVERY_GIT_PUSH_TIMEOUT_MS = "90001";
      process.env.DOCSFAB_DELIVERY_GIT_COMMIT_TIMEOUT_MS = "20001";
      process.env.DOCSFAB_DELIVERY_GIT_LS_REMOTE_TIMEOUT_MS = "40001";
      const calls = f.git.calls.length;
      await publish(f, await childAt(f, parent.head), {
        advance: advanceFrom(parent, parent.head),
      });
      const recorded = f.git.calls.slice(calls);
      const timeouts = (name: string) =>
        new Set(recorded.filter((call) => call.operation[0] === name).map((c) => c.timeoutMs));
      expect(timeouts("push")).toEqual(new Set([90_001]));
      expect(timeouts("commit-tree")).toEqual(new Set([20_001]));
      expect(timeouts("ls-remote")).toEqual(new Set([40_001]));
      const publisher = new DeterministicLocalGitPublisher(f.git, {
        PATH: process.env.PATH,
        HOME: f.home,
      });
      const head = (await bareHead(f.bare, branch))!;
      await publisher.deleteRemoteBranch({
        target: parent.plan,
        branch,
        expectedRevision: head,
        cwd: f.source,
      });
      expect(f.git.pushes().at(-1)!.operation).toContain(`:refs/heads/${branch}`);
      expect(f.git.pushes().at(-1)!.timeoutMs).toBe(90_001);
      expect(await bareHead(f.bare, branch)).toBeUndefined();
    },
    SLOW,
  );
});

describe("leased branch advance: contracts", () => {
  const plan = (
    advance: Partial<LocalUserPublicationAdvanceV1> = {},
  ): LocalUserPublicationPlanV3 => {
    const value = {
      schemaVersion: 3,
      kind: "docsfab-local-user-gitlab-publication-plan",
      deliveryMode: "local-user",
      authorityBasis: "interactive-once",
      run: { id: "run-child", recordSha256: "a".repeat(64) },
      project: { id: PROJECT_ID, host: "gitlab.example.test", path: "group/docs" },
      remote: { name: "origin", transport: "https" },
      identity: {
        git: "configured",
        gitIdentitySha256: "b".repeat(64),
        gitlabUsername: USERNAME,
        gitlabUserId: 7,
      },
      baseRevision: "c".repeat(40),
      targetBranch: { name: "main", protected: true },
      proposedSourceBranch: "docsfab-run/run-parent",
      patch: { format: "git-diff", sha256: "d".repeat(64), byteLength: 10, changedFileCount: 1 },
      validationCommand: "node validate.cjs",
      mergeRequest: { draft: true },
      fallback: { mode: "patch-only", preserved: true },
      checks: {
        repository: "passed",
        remote: "passed",
        revision: "descends-from-recorded-head",
        gitIdentity: "configured",
        gitlabAuthentication: "authenticated",
        pushAccess: "allowed",
        sourceBranch: "unprotected",
      },
      advance: {
        kind: "docsfab-local-user-publication-advance",
        parent: {
          runId: "run-parent",
          recordSha256: "e".repeat(64),
          deliveryReceiptSha256: "f".repeat(64),
          idempotencyKey: "1".repeat(64),
          planSha256: "2".repeat(64),
        },
        mergeRequest: { projectId: PROJECT_ID, iid: 17 },
        sourceBranch: "docsfab-run/run-parent",
        lastRecordedHead: "9".repeat(40),
        observedHead: "c".repeat(40),
        ordinal: 1,
        ...advance,
      },
      sha256: "",
    } as LocalUserPublicationPlanV3;
    return { ...value, sha256: localUserPublicationPlanSha256(value) };
  };

  it("binds the previous head and the parent receipt into the advance key", () => {
    const base = scmDeliveryIdempotencyKey(plan());
    expect(scmDeliveryIdempotencyKey(plan({ lastRecordedHead: "8".repeat(40) }))).not.toBe(base);
    expect(
      scmDeliveryIdempotencyKey(
        plan({ parent: { ...plan().advance.parent, deliveryReceiptSha256: "7".repeat(64) } }),
      ),
    ).not.toBe(base);
    const unchained = scmDeliveryIdentityKey({
      provider: "gitlab",
      run: plan().run,
      repository: { projectId: PROJECT_ID, host: "gitlab.example.test", path: "group/docs" },
      baseRevision: "c".repeat(40),
      targetBranch: "main",
      patchSha256: "d".repeat(64),
    });
    expect(base).not.toBe(unchained);
  });

  it("reports a ready MR only to an advance; a first publication still refuses it", async () => {
    const ready = {
      iid: 17,
      state: "opened",
      draft: false,
      title: "[DocsFab Run] Ready",
      description: "ready",
      source_branch: "docsfab-run/run-parent",
      target_branch: "main",
      sha: "c".repeat(40),
      source_project_id: PROJECT_ID,
      target_project_id: PROJECT_ID,
    };
    const runner: GitLabPublisherCommandRunner = {
      run: async () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify([ready])) }),
    };
    const adapter = new LocalUserGitLabPublisherAdapter(runner, {});
    const advancing = plan();
    const { advance: _advance, ...rest } = advancing;
    const firstPublication = {
      ...rest,
      schemaVersion: 2,
      identity: { git: "configured", gitIdentitySha256: "b".repeat(64), gitlabUsername: USERNAME },
      checks: { ...advancing.checks, revision: "current" },
      sha256: "",
    } as LocalUserPublicationPlan;
    const firstPlan = {
      ...firstPublication,
      sha256: localUserPublicationPlanSha256(firstPublication),
    };
    expect((await adapter.findMergeRequests(advancing, "/"))[0]).toMatchObject({ draft: false });
    expect((await failure(() => adapter.findMergeRequests(firstPlan, "/"))).code).toBe(
      "invalid-response",
    );
  });

  it("adopts a composition parent only under its exact title; a legacy parent may be retitled", () => {
    const { advance: _a, ...v2 } = plan();
    const legacyPlanBody = {
      ...v2,
      schemaVersion: 2,
      identity: { git: "configured", gitIdentitySha256: "b".repeat(64), gitlabUsername: USERNAME },
      checks: { ...v2.checks, revision: "current" },
    } as LocalUserPublicationPlan;
    const legacyPlan = {
      ...legacyPlanBody,
      sha256: localUserPublicationPlanSha256(legacyPlanBody),
    };
    const run: VerifiedPublicationRun = {
      id: "run-parent",
      workflow: "site-bootstrap",
      workflowOutcome: "Bootstrap the documentation site",
      recordSha256: legacyPlan.run.recordSha256,
      sourcePath: "/source",
      revision: legacyPlan.baseRevision,
      patch: legacyPlan.patch as unknown as VerifiedPublicationRun["patch"],
      patchBytes: Buffer.from("patch"),
      changedFiles: [{ path: "guide.md", status: "modified" }],
      changedFileCount: 1,
      taskLineage: null,
    };
    const legacy = buildRunPublicationMetadata(legacyPlan, run);
    expect(
      hasExactDocsFabPublicationMetadata(
        "Draft: [DocsFab Run] retitled by a human",
        `human prose\n${legacy.mergeRequestProvenanceMarker}\n`,
        legacy,
      ),
    ).toBe(true);
    const composition = buildRunPublicationMetadata(legacyPlan, {
      ...run,
      compositionExecution: createCompositionPublicationBinding({
        compositionId: "composition-a",
        evidenceSha256: "5".repeat(64),
        aggregateSha256: "6".repeat(64),
      }),
    });
    expect(
      hasExactDocsFabPublicationMetadata(
        composition.mergeRequestTitle,
        composition.mergeRequestDescription,
        composition,
      ),
    ).toBe(true);
    expect(
      hasExactDocsFabPublicationMetadata(
        "Draft: [DocsFab] COMPOSITION — retitled by a human",
        composition.mergeRequestDescription,
        composition,
      ),
    ).toBe(false);
    expect(composition.mergeRequestProvenanceMarker).not.toBe(legacy.mergeRequestProvenanceMarker);
  });
});
