// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

import {
  FileScmDeliveryReceiptStore,
  GitLabPublisherAdapterError,
  GitPublisherError,
  authorizeLocalUserPublication,
  buildDocsFabPublicationMetadata,
  buildDocsFabCompositionExecutionMarker,
  createCompositionPublicationBinding,
  hasExactDocsFabPublicationMetadata,
  hasExactDocsFabPublicationProvenance,
  createScmDeliveryRecord,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  observeLocalUserGitLabDelivery,
  publicationMetadataInputDigests,
  publishLocalUserGitLab,
  recordScmDeliveryProgress,
  type DeliveryWorktreeCapability,
  type DeliveryWorktreeReadyAttestation,
  type GitLabMergeRequest,
  type GitLabPublicationPolicy,
  type GitLabPublisherAdapter,
  type LocalGitPublisher,
  type LocalUserPublicationPlan,
  type LocalUserPublicationPlanV1,
  type LocalUserPublicationPlanV2,
  type ScmDeliveryRecord,
  type ScmDeliveryReceiptClaim,
  type ScmDeliveryReceiptStore,
} from "../src/delivery/index.js";
import {
  documentationValidationKit,
  selectDocumentationValidationProfile,
} from "../src/delivery/validation-profile.js";
import { validationBackendPolicySha256 } from "../src/delivery/worktree/validation-backend.js";
import { credentialFindingLocation } from "../src/security/credential-findings.js";
import { requiredCheckIsolationRemedy } from "../src/workflow-execution/check-isolation-selection.js";
import { formatRequiredCheckLimitation } from "../src/workflow-execution/required-check-limitation.js";
import { requiredRepositoryChecks } from "../src/workflow-execution/workflow-checks.js";
import {
  resetStartupPublicRootsForTest,
  validateStartupPublicRoots,
} from "../src/security/host-roots.js";

const BASE = "a".repeat(40);
const TREE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const NOW = new Date("2026-08-04T12:00:00.000Z");
/** Real git/CLI publisher flows need headroom under parallel Vitest workers. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;
const publisherTemporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    publisherTemporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class MemoryStore implements ScmDeliveryReceiptStore {
  public record?: ScmDeliveryRecord;
  public writes = 0;
  public withMergeRequestLease?: <T>(
    idempotencyKey: string,
    action: () => Promise<T>,
  ) => Promise<T>;
  public async load(): Promise<ScmDeliveryRecord | undefined> {
    return this.record;
  }
  public async claim(record: ScmDeliveryRecord): Promise<ScmDeliveryReceiptClaim> {
    if (!this.record) {
      this.record = record;
      this.writes += 1;
      return { record, created: true };
    }
    return { record: this.record, created: false };
  }
  public async compareAndSwap(
    expected: string,
    record: ScmDeliveryRecord,
  ): Promise<ScmDeliveryRecord> {
    if (!this.record || this.record.sha256 !== expected) throw new Error("CAS conflict");
    this.record = record;
    this.writes += 1;
    return record;
  }
}

class FakeGit implements LocalGitPublisher {
  public local = BASE;
  public remote?: string;
  public commits = 0;
  public pushes = 0;
  public rejectPush = false;
  public deleteRemoteOnObservation = false;
  public async assertConfiguredIdentity(): Promise<void> {}
  public async localBranchRevision(): Promise<string | undefined> {
    return this.local;
  }
  public async remoteBranchRevision(): Promise<string | undefined> {
    return this.deleteRemoteOnObservation ? undefined : this.remote;
  }
  public async ensureCommit(): Promise<string> {
    this.commits += 1;
    if (this.local !== BASE && this.local !== COMMIT) throw new Error("conflict");
    this.local = COMMIT;
    return COMMIT;
  }
  public async ensurePush(): Promise<string> {
    if (this.rejectPush) throw new Error("rejected");
    if (this.remote && this.remote !== COMMIT) throw new Error("conflict");
    if (!this.remote) this.pushes += 1;
    this.remote = COMMIT;
    return COMMIT;
  }
  public async assertCommit(input: { commitRevision: string }): Promise<void> {
    if (input.commitRevision !== COMMIT || this.local !== COMMIT) throw new Error("commit drift");
  }
}

class FakeGitLab implements GitLabPublisherAdapter {
  public policy: GitLabPublicationPolicy = {
    username: "maintainer",
    projectId: 42,
    projectPath: "group/docs",
    accessLevel: 30,
    defaultBranch: "main",
    targetBranch: { name: "main", protected: true, revision: BASE },
    sourceBranchProtected: false,
  };
  public requests: GitLabMergeRequest[] = [];
  public creates = 0;
  public rejectOpen = false;
  public async inspectPolicy(): Promise<GitLabPublicationPolicy> {
    return this.policy;
  }
  public async findMergeRequests(): Promise<GitLabMergeRequest[]> {
    return [...this.requests];
  }
  public async openDraftMergeRequest(input: {
    plan: LocalUserPublicationPlan;
    title: string;
    description: string;
    headRevision: string;
  }): Promise<GitLabMergeRequest> {
    if (this.rejectOpen) throw new Error("MR unavailable");
    this.creates += 1;
    const request: GitLabMergeRequest = {
      iid: 7,
      url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
      state: "opened",
      draft: true,
      sourceBranch: input.plan.proposedSourceBranch,
      targetBranch: input.plan.targetBranch.name,
      headRevision: input.headRevision,
      sourceProjectId: input.plan.project.id,
      targetProjectId: input.plan.project.id,
      title: input.title,
      description: input.description,
    };
    this.requests = [request];
    return request;
  }
}

describe("host-only local-user GitLab publisher", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("persists every boundary and returns one terminal draft MR capability", async () => {
    const fixture = inputs();
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;
    expect(result.record.state).toBe("opened");
    expect(result.record.attempts.map((attempt) => attempt.toState)).toEqual([
      "prepared",
      "validated",
      "committed",
      "pushed",
      "opened",
    ]);
    expect(result.record.evidence.commit?.sha).toBe(COMMIT);
    expect(result.record.evidence.push?.remoteRevision).toBe(COMMIT);
    expect(result.mergeRequest).toMatchObject({ iid: 7, draft: true, headRevision: COMMIT });
    expect(result.terminalCapability.kind).toBe("docsfab-scm-published-terminal-capability");
    expect(fixture.store.writes).toBe(6);
    expect(fixture.git.commits).toBe(1);
    expect(fixture.git.pushes).toBe(1);
    expect(fixture.gitlab.creates).toBe(1);
  });

  it("publishes a verified run with an instruction larger than the metadata display limit", async () => {
    const fixture = inputs();
    const instruction = "Synthetic MR evidence ".repeat(400);
    const result = await publishLocalUserGitLab(
      { ...fixture.input, instruction },
      fixture.dependencies,
    );
    expect(result.status).toBe("opened");
    expect(fixture.gitlab.creates).toBe(1);
    expect(fixture.gitlab.requests[0]?.description).not.toContain(instruction);
  });

  it("reuses the exact commit, remote branch, MR, and receipt", async () => {
    const fixture = inputs();
    const first = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(first.status).toBe("opened");
    const writes = fixture.store.writes;
    const second = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(second.status).toBe("opened");
    expect(second.record).toEqual(first.record);
    expect(fixture.store.writes).toBe(writes);
    expect(fixture.git.commits).toBe(1);
    expect(fixture.git.pushes).toBe(1);
    expect(fixture.gitlab.creates).toBe(1);
  });

  it("adopts the marker-bound MR after a crash even when a human edits its title and prose", async () => {
    const fixture = inputs();
    const crash = new Error("crash-after-merge-request");
    await expect(
      publishLocalUserGitLab(fixture.input, {
        ...fixture.dependencies,
        hooks: {
          afterMergeRequest: () => {
            throw crash;
          },
        },
      }),
    ).rejects.toBe(crash);
    expect(fixture.store.record?.state).toBe("opened");
    const created = fixture.gitlab.requests[0]!;
    fixture.gitlab.requests = [
      {
        ...created,
        title: "Draft: A maintainer clarified this title",
        description: `Maintainer-authored context.\n\n${
          buildDocsFabPublicationMetadata({
            plan: fixture.input.plan,
            workflowOutcome: fixture.input.workflowOutcome,
            changedPaths: fixture.input.changedPaths,
          }).mergeRequestProvenanceMarker
        }`,
      },
    ];
    const recovered = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(recovered).toMatchObject({
      status: "opened",
      mergeRequest: { iid: created.iid },
    });
    expect(fixture.gitlab.requests[0]?.title).toBe("Draft: A maintainer clarified this title");
    expect(fixture.gitlab.creates).toBe(1);
  });

  it("confirms a newly posted MR by immutable marker even if its human title changes immediately", async () => {
    const fixture = inputs();
    const open = fixture.gitlab.openDraftMergeRequest.bind(fixture.gitlab);
    fixture.gitlab.openDraftMergeRequest = async (input) => {
      const request = await open(input);
      fixture.gitlab.requests = [{ ...request, title: "Draft: Human-edited during confirmation" }];
      return request;
    };
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result).toMatchObject({ status: "opened", mergeRequest: { iid: 7 } });
    expect(fixture.gitlab.requests[0]?.title).toBe("Draft: Human-edited during confirmation");
    expect(fixture.gitlab.creates).toBe(1);
  });

  it.each(["missing", "conflicting", "multiple"] as const)(
    "fails closed without another POST when the existing MR marker is %s",
    async (kind) => {
      const fixture = inputs();
      const first = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(first.status).toBe("opened");
      const request = fixture.gitlab.requests[0]!;
      const marker = buildDocsFabPublicationMetadata({
        plan: fixture.input.plan,
        workflowOutcome: fixture.input.workflowOutcome,
        changedPaths: fixture.input.changedPaths,
      }).mergeRequestProvenanceMarker;
      const description =
        kind === "missing"
          ? "Maintainer prose without a marker."
          : kind === "conflicting"
            ? marker.replace("v1", "v2")
            : `${marker}\n${marker}`;
      fixture.gitlab.requests = [{ ...request, description }];
      const replay = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(replay).toMatchObject({
        status: "failed",
        code: "merge-request-changed",
        lastConfirmedState: "opened",
      });
      expect(fixture.gitlab.creates).toBe(1);
    },
  );

  it.each(["remote", "merge-request"] as const)(
    "fails closed when the %s observation cannot be refreshed",
    async (boundary) => {
      const fixture = inputs();
      const published = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(published.status).toBe("opened");
      if (published.status !== "opened") return;
      const unavailable = new Error(`${boundary}-unavailable`);
      if (boundary === "remote") {
        fixture.git.remoteBranchRevision = async () => {
          throw unavailable;
        };
      } else {
        fixture.gitlab.findMergeRequests = async () => {
          throw unavailable;
        };
      }
      await expect(
        observeLocalUserGitLabDelivery({
          plan: fixture.input.plan,
          authorization: fixture.input.authorization,
          worktree: fixture.input.worktree,
          readyAttestation: fixture.input.readyAttestation,
          record: published.record,
          metadata: buildDocsFabPublicationMetadata({
            plan: fixture.input.plan,
            workflowOutcome: fixture.input.workflowOutcome,
            changedPaths: fixture.input.changedPaths,
          }),
          git: fixture.git,
          gitlab: fixture.gitlab,
          clock: fixture.dependencies.clock,
        }),
      ).rejects.toBe(unavailable);
    },
  );

  it.each(["commit", "push", "merge-request"] as const)(
    "resumes a crash after durably recording %s",
    async (boundary) => {
      const fixture = inputs();
      const crash = new Error(`crash-${boundary}`);
      const hooks =
        boundary === "commit"
          ? {
              afterCommit: () => {
                throw crash;
              },
            }
          : boundary === "push"
            ? {
                afterPush: () => {
                  throw crash;
                },
              }
            : {
                afterMergeRequest: () => {
                  throw crash;
                },
              };
      await expect(
        publishLocalUserGitLab(fixture.input, {
          ...fixture.dependencies,
          hooks,
        }),
      ).rejects.toBe(crash);
      expect(fixture.store.record?.state).toBe(
        boundary === "commit" ? "committed" : boundary === "push" ? "pushed" : "opened",
      );
      const recovered = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(recovered.status).toBe("opened");
      expect(fixture.git.commits).toBe(1);
      expect(fixture.git.pushes).toBe(1);
      expect(fixture.gitlab.creates).toBe(1);
    },
  );

  it("records push rejection without destroying the patch or worktree capability", async () => {
    const fixture = inputs();
    fixture.git.rejectPush = true;
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result).toMatchObject({
      status: "failed",
      code: "push-failed",
      lastConfirmedState: "committed",
      nextAction: "retry-push",
    });
    expect(fixture.input.worktree.state).toBe("ready");
    expect(result.record.patch.preserved).toBe(true);
  });

  it.each([
    // The check before each step passed, so these come from the re-check inside the step,
    // as when the configuration changes between the two. #2362, #2363
    ["policy", "identity-drift", "git-identity-drift", "restore-git-identity", "planned"],
    ["policy", "missing-identity", "git-identity-drift", "restore-git-identity", "planned"],
    [
      "policy",
      "refused-configuration",
      "git-configuration-refused",
      "remove-unsafe-git-configuration",
      "planned",
    ],
    // An old Git, a remote that no longer names the project, or a configuration listing
    // that does not parse: the Git state of the checkout, not GitLab. #2363
    ["policy", "unsafe-configuration", "git-checkout-unverified", "repair-git-checkout", "planned"],
    ["commit", "identity-drift", "git-identity-drift", "restore-git-identity", "validated"],
    ["commit", "missing-identity", "git-identity-drift", "restore-git-identity", "validated"],
    [
      "commit",
      "refused-configuration",
      "git-configuration-refused",
      "remove-unsafe-git-configuration",
      "validated",
    ],
    [
      "commit",
      "unsafe-configuration",
      "git-checkout-unverified",
      "repair-git-checkout",
      "validated",
    ],
    ["commit", "commit-failed", "commit-failed", "retry-commit", "validated"],
    ["push", "identity-drift", "git-identity-drift", "restore-git-identity", "committed"],
    ["push", "missing-identity", "git-identity-drift", "restore-git-identity", "committed"],
    [
      "push",
      "refused-configuration",
      "git-configuration-refused",
      "remove-unsafe-git-configuration",
      "committed",
    ],
    ["push", "unsafe-configuration", "git-checkout-unverified", "repair-git-checkout", "committed"],
    ["push", "remote-branch-conflict", "remote-drift", "reconcile-external-state", "committed"],
    ["push", "push-failed", "push-failed", "retry-push", "committed"],
  ] as const)(
    "maps a Git error at the %s step (%s) to %s, and keeps the patch",
    async (step, gitCode, code, nextAction, lastConfirmedState) => {
      const fixture = inputs();
      const refusal = async (): Promise<never> => {
        throw new GitPublisherError(gitCode);
      };
      if (step === "policy") fixture.git.assertConfiguredIdentity = refusal;
      else if (step === "commit") fixture.git.ensureCommit = refusal;
      else fixture.git.ensurePush = refusal;
      const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(result).toMatchObject({ status: "failed", code, lastConfirmedState, nextAction });
      expect(fixture.input.worktree.state).toBe("ready");
      expect(result.record.patch.preserved).toBe(true);
      expect(fixture.gitlab.creates).toBe(0);
    },
  );

  it("still reports a failure that is not Git's as remote-drift at the policy step", async () => {
    // Positive control for the Git-error mapping above: only a Git error is the
    // checkout's own state; anything else the policy check throws is GitLab drift.
    const fixture = inputs();
    fixture.git.assertConfiguredIdentity = async () => {
      throw new Error("unexpected");
    };
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result).toMatchObject({
      status: "failed",
      code: "remote-drift",
      nextAction: "reconcile-external-state",
    });
  });

  describe("a Git stop found on a retry after DocsFab committed (#2393)", () => {
    /**
     * A publication that stopped after a durable boundary, so its receipt is at `state` and still
     * retryable: a failed push leaves `committed`, a failed merge request leaves `pushed`.
     */
    async function stoppedFixture(state: "committed" | "pushed") {
      const fixture = inputs();
      fixture.git.rejectPush = state === "committed";
      fixture.gitlab.rejectOpen = state === "pushed";
      const failed = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(failed).toMatchObject({
        status: "failed",
        code: state === "committed" ? "push-failed" : "merge-request-open-failed",
        lastConfirmedState: state,
      });
      fixture.git.rejectPush = false;
      fixture.gitlab.rejectOpen = false;
      return fixture;
    }

    function observationFails(fixture: ReturnType<typeof inputs>, error: Error): void {
      fixture.git.remoteBranchRevision = async () => {
        throw error;
      };
    }

    it.each([
      [
        "committed",
        "refused-configuration",
        "git-configuration-refused",
        "remove-unsafe-git-configuration",
      ],
      ["committed", "unsafe-configuration", "git-checkout-unverified", "repair-git-checkout"],
      [
        "pushed",
        "refused-configuration",
        "git-configuration-refused",
        "remove-unsafe-git-configuration",
      ],
      ["pushed", "unsafe-configuration", "git-checkout-unverified", "repair-git-checkout"],
    ] as const)(
      "after %s, reports %s as %s, leaves the receipt retryable, and publishes once the cause is gone",
      async (state, gitCode, code, nextAction) => {
        const fixture = await stoppedFixture(state);
        observationFails(fixture, new GitPublisherError(gitCode));
        const stopped = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
        expect(stopped).toMatchObject({
          status: "failed",
          code,
          nextAction,
          lastConfirmedState: state,
        });
        // Not recovered to patch-only: the operator can remove the setting.
        expect(stopped.record.disposition).toBe("failed");
        expect(stopped.record.recovery).toBeUndefined();
        expect(stopped.record.failure?.code).toBe(code);
        expect(fixture.gitlab.creates).toBe(0);
        // The retry that finds the cause again reports it again, still retryable.
        const again = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
        expect(again).toMatchObject({ status: "failed", code, nextAction });
        expect(again.record.disposition).toBe("failed");

        // Positive control: with the cause removed, the same receipt publishes.
        fixture.git.remoteBranchRevision = async () => fixture.git.remote;
        const opened = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
        expect(opened.status).toBe("opened");
        expect(fixture.gitlab.creates).toBe(1);
        expect(fixture.git.pushes).toBe(1);
      },
    );

    it("keeps reporting any other observation failure as receipt-drift and recovers the receipt", async () => {
      // Positive control for the mapping above: an unrelated failure is unchanged.
      const fixture = await stoppedFixture("committed");
      observationFails(fixture, new Error("remote unavailable"));
      const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(result).toMatchObject({
        status: "failed",
        code: "receipt-drift",
        nextAction: "review-preserved-patch",
      });
      expect(result.record.disposition).toBe("recovered");
    });

    it.each([
      ["refused-configuration", "git-configuration-refused"],
      ["unsafe-configuration", "git-checkout-unverified"],
    ] as const)(
      "reports %s on a receipt that was already recovered as %s, with review-preserved-patch, without rewriting it",
      async (gitCode, code) => {
        // A receipt recovered to patch-only is settled: it cannot record another failure, so the
        // stop is reported as it is. Before, the retry threw an invalid transition. Removing the
        // setting cannot publish a recovered receipt, so the next action is not to remove it.
        const fixture = await stoppedFixture("committed");
        observationFails(fixture, new Error("remote unavailable"));
        const recovered = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
        expect(recovered.record.disposition).toBe("recovered");
        const writes = fixture.store.writes;
        observationFails(fixture, new GitPublisherError(gitCode));
        const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
        expect(result).toMatchObject({
          status: "failed",
          code,
          nextAction: "review-preserved-patch",
          lastConfirmedState: "committed",
        });
        expect(result.record.disposition).toBe("recovered");
        expect(fixture.store.writes).toBe(writes);
      },
    );

    it.each(["committed", "pushed"] as const)(
      "records the stop on a receipt left active at %s by a crash, so the retry can publish",
      async (boundary) => {
        // No failure was ever recorded: the process died after the durable boundary. The stop must
        // be persisted as a failure (the receipt becomes failed and retryable), not only reported.
        const fixture = inputs();
        const crash = new Error(`crash-${boundary}`);
        const hooks =
          boundary === "committed"
            ? {
                afterCommit: () => {
                  throw crash;
                },
              }
            : {
                afterPush: () => {
                  throw crash;
                },
              };
        await expect(
          publishLocalUserGitLab(fixture.input, { ...fixture.dependencies, hooks }),
        ).rejects.toBe(crash);
        expect(fixture.store.record).toMatchObject({ state: boundary, disposition: "active" });

        observationFails(fixture, new GitPublisherError("refused-configuration"));
        const stopped = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
        expect(stopped).toMatchObject({
          status: "failed",
          code: "git-configuration-refused",
          nextAction: "remove-unsafe-git-configuration",
          lastConfirmedState: boundary,
        });
        expect(stopped.record.disposition).toBe("failed");
        expect(stopped.record.failure?.code).toBe("git-configuration-refused");
        expect(stopped.record.recovery).toBeUndefined();
        expect(fixture.store.record?.disposition).toBe("failed");

        // Positive control: with the cause gone, the same receipt publishes.
        fixture.git.remoteBranchRevision = async () => fixture.git.remote;
        const opened = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
        expect(opened.status).toBe("opened");
        expect(fixture.gitlab.creates).toBe(1);
      },
    );

    it("reports a refused setting after the merge request opened without touching the succeeded receipt", async () => {
      const fixture = inputs();
      const opened = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(opened.status).toBe("opened");
      const writes = fixture.store.writes;
      observationFails(fixture, new GitPublisherError("refused-configuration"));
      const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(result).toMatchObject({
        status: "failed",
        code: "git-configuration-refused",
        nextAction: "remove-unsafe-git-configuration",
        lastConfirmedState: "opened",
      });
      expect(result.record.disposition).toBe("succeeded");
      expect(fixture.store.writes).toBe(writes);
    });
  });

  it("fails before commit when the source becomes protected or default", async () => {
    for (const policy of [
      { sourceBranchProtected: true, defaultBranch: "main" },
      { sourceBranchProtected: false, defaultBranch: "docsfab-run/run-1" },
    ]) {
      const fixture = inputs();
      fixture.gitlab.policy = { ...fixture.gitlab.policy, ...policy };
      const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(result).toMatchObject({ status: "failed", code: "remote-drift" });
      expect(fixture.git.commits).toBe(0);
      expect(fixture.git.pushes).toBe(0);
    }
  });

  it("rechecks the exact pushed revision before opening an MR", async () => {
    const fixture = inputs();
    fixture.git.deleteRemoteOnObservation = true;
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result).toMatchObject({
      status: "failed",
      code: "remote-branch-deleted",
      lastConfirmedState: "pushed",
    });
    expect(fixture.gitlab.creates).toBe(0);
  });

  it.each([
    "remote-revision",
    "target-delete",
    "target-protection",
    "access-downgrade",
    "default-branch",
    "source-protection",
    "project-identity",
  ] as const)("rechecks %s after acquiring the contended MR lease", async (boundary) => {
    const fixture = inputs();
    const crash = new Error("crash-after-push");
    await expect(
      publishLocalUserGitLab(fixture.input, {
        ...fixture.dependencies,
        hooks: {
          afterPush: () => {
            throw crash;
          },
        },
      }),
    ).rejects.toBe(crash);
    let entered!: () => void;
    const leaseEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const leaseReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.store.withMergeRequestLease = async (_key, action) => {
      entered();
      await leaseReleased;
      return action();
    };
    const publishing = publishLocalUserGitLab(fixture.input, fixture.dependencies);
    await leaseEntered;
    switch (boundary) {
      case "remote-revision":
        fixture.git.remote = "d".repeat(40);
        break;
      case "target-delete":
        fixture.gitlab.inspectPolicy = async () => {
          throw new GitLabPublisherAdapterError("external-failure");
        };
        break;
      case "target-protection":
        fixture.gitlab.policy.targetBranch.protected = false;
        break;
      case "access-downgrade":
        fixture.gitlab.policy.accessLevel = 20;
        break;
      case "default-branch":
        fixture.gitlab.policy.defaultBranch = "docsfab-run/run-1";
        break;
      case "source-protection":
        fixture.gitlab.policy.sourceBranchProtected = true;
        break;
      case "project-identity":
        fixture.gitlab.policy.projectPath = "other/docs";
        break;
    }
    release();
    const result = await publishing;
    expect(result).toMatchObject({
      status: "failed",
      code: "remote-drift",
      lastConfirmedState: "pushed",
    });
    expect(fixture.gitlab.creates).toBe(0);
  });

  it("allows the protected target branch to advance after revision-bound preflight", async () => {
    const fixture = inputs();
    fixture.gitlab.policy.targetBranch.revision = "d".repeat(40);

    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);

    expect(result.status).toBe("opened");
    expect(fixture.git.commits).toBe(1);
    expect(fixture.git.pushes).toBe(1);
    expect(fixture.gitlab.creates).toBe(1);
  });

  it("allows the target to advance after MR lookup and immediately before POST", async () => {
    const fixture = inputs();
    const crash = new Error("crash-after-push");
    await expect(
      publishLocalUserGitLab(fixture.input, {
        ...fixture.dependencies,
        hooks: {
          afterPush: () => {
            throw crash;
          },
        },
      }),
    ).rejects.toBe(crash);
    let insideLease = false;
    fixture.store.withMergeRequestLease = async (_key, action) => {
      insideLease = true;
      try {
        return await action();
      } finally {
        insideLease = false;
      }
    };
    const find = fixture.gitlab.findMergeRequests.bind(fixture.gitlab);
    fixture.gitlab.findMergeRequests = async () => {
      const requests = await find();
      if (insideLease) fixture.gitlab.policy.targetBranch.revision = "d".repeat(40);
      return requests;
    };
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result.status).toBe("opened");
    expect(fixture.gitlab.creates).toBe(1);
  });

  it.each(["authentication-unavailable", "provider-observation-failed"] as const)(
    "durably recovers the exact patch when %s during replay",
    async (failure) => {
      const fixture = inputs();
      const crash = new Error("crash-after-push");
      await expect(
        publishLocalUserGitLab(fixture.input, {
          ...fixture.dependencies,
          hooks: {
            afterPush: () => {
              throw crash;
            },
          },
        }),
      ).rejects.toBe(crash);
      if (failure === "authentication-unavailable") {
        fixture.gitlab.inspectPolicy = async () => {
          throw new GitLabPublisherAdapterError("authentication-unavailable");
        };
      } else {
        fixture.gitlab.findMergeRequests = async () => {
          throw new Error("provider unavailable");
        };
      }
      const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(result).toMatchObject({
        status: "failed",
        code:
          failure === "authentication-unavailable" ? "authentication-unavailable" : "receipt-drift",
        lastConfirmedState: "pushed",
        nextAction: "review-preserved-patch",
        record: { disposition: "recovered", recovery: { preserved: true } },
      });
      expect(fixture.gitlab.creates).toBe(0);
    },
  );

  it("enters durable patch-only recovery when authentication is unavailable before commit", async () => {
    const fixture = inputs();
    fixture.gitlab.inspectPolicy = async () => {
      throw new GitLabPublisherAdapterError("authentication-unavailable");
    };
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result).toMatchObject({
      status: "failed",
      code: "authentication-unavailable",
      lastConfirmedState: "planned",
      nextAction: "review-preserved-patch",
      record: { state: "planned", disposition: "recovered" },
    });
    expect(fixture.git.commits).toBe(0);
    expect(fixture.git.pushes).toBe(0);
  });

  it("returns a structured expiry after commit and before push", async () => {
    const fixture = inputs({ expiresAt: "2026-08-04T12:01:00.000Z" });
    let now = new Date(NOW);
    const result = await publishLocalUserGitLab(fixture.input, {
      ...fixture.dependencies,
      clock: () => new Date(now),
      hooks: {
        afterCommit: () => {
          now = new Date("2026-08-04T12:02:00.000Z");
        },
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      code: "authorization-expired",
      lastConfirmedState: "committed",
      nextAction: "issue-fresh-authorization",
    });
    expect(fixture.git.pushes).toBe(0);
  });

  it("uses immutable plan and worktree snapshots across provider awaits", async () => {
    const fixture = inputs();
    const originalPolicy = fixture.gitlab.inspectPolicy.bind(fixture.gitlab);
    fixture.gitlab.inspectPolicy = async () => {
      (fixture.input.plan as { proposedSourceBranch: string }).proposedSourceBranch = "main";
      (fixture.input.worktree as { worktreePath: string }).worktreePath = "/attacker";
      return originalPolicy();
    };
    const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(result.status).toBe("opened");
    if (result.status === "opened")
      expect(result.mergeRequest.sourceBranch).toBe("docsfab-run/run-1");
  });

  it("serializes concurrent MR creation attempts for one delivery", async () => {
    const fixture = inputs();
    fixture.gitlab.rejectOpen = true;
    const failed = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(failed).toMatchObject({ status: "failed", lastConfirmedState: "pushed" });
    fixture.gitlab.rejectOpen = false;
    const results = await Promise.allSettled([
      publishLocalUserGitLab(fixture.input, fixture.dependencies),
      publishLocalUserGitLab(fixture.input, fixture.dependencies),
    ]);
    expect(
      results.some((result) => result.status === "fulfilled" && result.value.status === "opened"),
    ).toBe(true);
    expect(fixture.gitlab.creates).toBe(1);
  });

  it("serializes the non-idempotent MR POST across complete publisher processes", async () => {
    const fixture = await durableProcessFixture();
    await Promise.all([
      publisherProcess(fixture.configPath, "normal"),
      publisherProcess(fixture.configPath, "normal"),
    ]);
    expect(await postCount(fixture.markerPath)).toBe(1);
    expect((await fixture.store.load(fixture.idempotencyKey))?.state).toBe("opened");
  }, 20_000);

  it.each(["crash-before-post", "crash-after-post"] as const)(
    "recovers a publisher process %s without duplicating the MR",
    async (mode) => {
      const fixture = await durableProcessFixture();
      await expect(publisherProcess(fixture.configPath, mode)).rejects.toThrow();
      expect((await fixture.store.load(fixture.idempotencyKey))?.state).toBe("pushed");
      await expect(publisherProcess(fixture.configPath, "normal")).resolves.toBeUndefined();
      expect(await postCount(fixture.markerPath)).toBe(1);
      expect((await fixture.store.load(fixture.idempotencyKey))?.state).toBe("opened");
    },
    20_000,
  );

  it.each(["remote-branch-deleted", "merge-request-closed", "authentication-revoked"] as const)(
    "reconciles terminal %s drift without another mutation",
    async (code) => {
      const fixture = inputs();
      const opened = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(opened.status).toBe("opened");
      if (code === "remote-branch-deleted") fixture.git.remote = undefined;
      if (code === "merge-request-closed")
        fixture.gitlab.requests[0] = {
          ...fixture.gitlab.requests[0]!,
          state: "closed",
        };
      if (code === "authentication-revoked") fixture.gitlab.policy.username = "other-maintainer";
      const replay = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(replay).toMatchObject({ status: "failed", code, lastConfirmedState: "opened" });
      expect(fixture.git.commits).toBe(1);
      expect(fixture.git.pushes).toBe(1);
      expect(fixture.gitlab.creates).toBe(1);
    },
  );

  it("returns structured recovery guidance when terminal GitLab authentication is unavailable", async () => {
    const fixture = inputs();
    const opened = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(opened.status).toBe("opened");
    fixture.gitlab.inspectPolicy = async () => {
      throw new GitLabPublisherAdapterError("authentication-unavailable");
    };
    const replay = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
    expect(replay).toMatchObject({
      status: "failed",
      code: "authentication-unavailable",
      lastConfirmedState: "opened",
      nextAction: "restore-authentication",
      record: { disposition: "succeeded" },
    });
    expect(fixture.gitlab.creates).toBe(1);
  });

  it("rejects expired authorization before an SCM boundary", async () => {
    const fixture = inputs({ expiresAt: "2026-08-04T12:01:00.000Z" });
    await expect(
      publishLocalUserGitLab(fixture.input, {
        ...fixture.dependencies,
        clock: () => new Date("2026-08-04T12:01:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "authorization-expired" });
    expect(fixture.store.record).toBeUndefined();
  });

  it("builds bounded metadata and rejects markdown, controls, configured credentials, and count drift", () => {
    const plan = makePlan();
    expect(
      buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Improve governed documentation",
        changedPaths: ["docs/guide.md"],
      }).commitMessage,
    ).toContain("DocsFab-Patch-SHA256");
    for (const outcome of [
      "<script>alert(1)</script>",
      "![x](https://evil.test)",
      "bad\u202etext",
    ]) {
      expect(() =>
        buildDocsFabPublicationMetadata({
          plan,
          workflowOutcome: outcome,
          changedPaths: ["docs/guide.md"],
        }),
      ).toThrow();
    }
    // A path DocsFab's own configured credential is in refuses; it looks like
    // no credential, so only the exact match can refuse that path. See #1807.
    for (const path of ["docs/`bad`.md", `docs/${plantConfiguredCredential()}.md`]) {
      expect(() =>
        buildDocsFabPublicationMetadata({
          plan,
          workflowOutcome: "Safe outcome",
          changedPaths: [path],
        }),
      ).toThrow();
    }
    clearPlantedCredential();
    expect(() =>
      buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Safe outcome",
        changedPaths: [],
      }),
    ).toThrow();
  });

  it("publishes a credential-like path and names it in the Notes block, never the value (#1807)", () => {
    const shaped = ["docs/glpat", "flagged-page.md"].join("-");
    const metadata = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: [shaped],
    });
    const description = metadata.mergeRequestDescription;
    expect(description).toContain(`  - \`${shaped}\``);
    const notes = description.slice(description.indexOf("## Notes"), description.indexOf("---"));
    expect(notes).toBe(
      "## Notes\n\n- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `publication:changedPaths` (`credential.gitlab-token`)\n\n",
    );
    expect(description.indexOf("## Result")).toBeLessThan(description.indexOf("## Notes"));
    expect(notes).not.toContain("flagged-page");
  });

  it("lists the run record's findings with the field findings, sorted, and adds no block without any", () => {
    const plan = makePlan();
    const clean = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
    });
    expect(clean.mergeRequestDescription).not.toContain("## Notes");
    expect(clean.mergeRequestDescription).not.toContain("Credential-like content");
    const recorded = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Safe outcome",
      changedPaths: [["docs/glpat", "flagged-page.md"].join("-")],
      credentialFindings: [
        {
          code: "credential-like-content",
          location: "docs/secrets.md:12",
          rule: "credential.assigned-secret",
        },
        { code: "credential-like-content", location: "docs/a.md:3", rule: "credential.jwt" },
      ],
    });
    expect(recorded.mergeRequestDescription).toContain(
      "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `docs/a.md:3` (`credential.jwt`), `docs/secrets.md:12` (`credential.assigned-secret`), `publication:changedPaths` (`credential.gitlab-token`)",
    );
  });

  it("names as many findings as the description bound allows and counts the rest", () => {
    const credentialFindings = Array.from({ length: 2_000 }, (_item, index) => ({
      code: "credential-like-content" as const,
      location: `docs/generated/page-${String(index).padStart(4, "0")}.md:${index + 1}`,
      rule: "credential.assigned-secret",
    }));
    const metadata = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
      credentialFindings,
    });
    const description = metadata.mergeRequestDescription;
    expect(description.length).toBeLessThanOrEqual(8_192);
    const line = description.split("\n").find((text) => text.startsWith("- **Credential-like"))!;
    const listed = line.match(/`docs\/generated\//gu)?.length ?? 0;
    expect(listed).toBeGreaterThan(0);
    expect(line).toMatch(new RegExp(`, and ${credentialFindings.length - listed} more$`, "u"));
    // One more listed finding would not fit.
    expect(listed).toBeLessThan(credentialFindings.length);
  });

  it("counts, never shows, finding locations whose file names could inject Markdown or quick actions (#1807)", () => {
    const finding = (location: string, rule = "credential.assigned-secret") => ({
      code: "credential-like-content" as const,
      location,
      rule,
    });
    // File names a repository can hold: a backtick that ends the code span
    // early, line feeds that start GitLab quick actions, and a tab.
    const backtick = ["docs/a", "@all", "b.md:3"].join("`");
    const lineFeeds = ["docs/x`", "/label ~x", "/assign_reviewer @someone", "`y.md:1"].join("\n");
    const tab = "docs/tab\there.md:2";
    const metadata = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
      credentialFindings: [
        finding(backtick),
        finding(lineFeeds),
        finding(tab),
        finding("docs/safe.md:4", "credential.jwt"),
      ],
    });
    const description = metadata.mergeRequestDescription;
    const notes = description.slice(description.indexOf("## Notes"), description.indexOf("---"));
    expect(notes).toBe(
      [
        "## Notes",
        "",
        "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `docs/safe.md:4` (`credential.jwt`)",
        "- 3 more findings in file names that cannot be shown safely here; the run record lists them.",
        "",
        "",
      ].join("\n"),
    );
    for (const line of description.split("\n")) expect(line.startsWith("/"), line).toBe(false);
    expect(description).not.toContain("/label");
    expect(description).not.toContain("/assign_reviewer");
    expect(description).not.toContain("@all");
    expect(description).not.toContain("\t");
    expect((notes.match(/`/gu) ?? []).length % 2).toBe(0);
    // Only unshowable findings still leave the count, alone.
    const unshown = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
      credentialFindings: [finding(lineFeeds)],
    }).mergeRequestDescription;
    expect(unshown.slice(unshown.indexOf("## Notes"), unshown.indexOf("---"))).toBe(
      "## Notes\n\n- 1 more finding in file names that cannot be shown safely here; the run record lists it.\n\n",
    );
  });

  it("keeps the count of unshowable findings when the description bound truncates the list", () => {
    const credentialFindings = [
      ...Array.from({ length: 2_000 }, (_item, index) => ({
        code: "credential-like-content" as const,
        location: `docs/generated/page-${String(index).padStart(4, "0")}.md:${index + 1}`,
        rule: "credential.assigned-secret",
      })),
      {
        code: "credential-like-content" as const,
        location: "docs/x\n/label ~x\n.md:1",
        rule: "credential.assigned-secret",
      },
    ];
    const description = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
      credentialFindings,
    }).mergeRequestDescription;
    expect(description.length).toBeLessThanOrEqual(8_192);
    const lines = description.split("\n");
    const listedLine = lines.find((text) => text.startsWith("- **Credential-like"))!;
    expect(listedLine).toMatch(/, and [0-9]+ more$/u);
    expect(lines).toContain(
      "- 1 more finding in file names that cannot be shown safely here; the run record lists it.",
    );
    expect(description).not.toContain("/label");
  });

  it("counts file names a closing keyword could use, so GitLab finds no issue to close (#1807)", () => {
    const finding = (location: string) => ({
      code: "credential-like-content" as const,
      location,
      rule: "credential.assigned-secret",
    });
    // GitLab reads closing keywords in the raw description, code spans included.
    const crafted = [
      "docs/Closes #1.md:3",
      "docs/fix #12.md:1",
      "docs/Resolves other-group/other-project#5.md:2",
    ];
    for (const location of crafted) {
      expect(location.match(GITLAB_CLOSING_PATTERN)?.[0], location).toBeTruthy();
    }
    const description = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
      credentialFindings: [
        ...crafted.map(finding),
        finding("docs/café.md:12"),
        finding("docs/reference/api.md:7"),
      ],
    }).mergeRequestDescription;
    expect(description.match(GITLAB_CLOSING_PATTERN)).toBeNull();
    const notes = description.slice(description.indexOf("## Notes"), description.indexOf("---"));
    expect(notes).toBe(
      [
        "## Notes",
        "",
        "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `docs/café.md:12` (`credential.assigned-secret`), `docs/reference/api.md:7` (`credential.assigned-secret`)",
        "- 3 more findings in file names that cannot be shown safely here; the run record lists them.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("shows a location the run recorder escaped, since it stays inside its code span (#1807)", () => {
    // The recorder writes control and format characters as \uXXXX, so the
    // location holds backslashes but no raw line break, space or backtick.
    const escaped = String.raw`docs/x\u000a\u202eb\u2028.md:4`;
    const description = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
      credentialFindings: [
        { code: "credential-like-content", location: escaped, rule: "credential.assigned-secret" },
      ],
    }).mergeRequestDescription;
    expect(description).toContain(`\`${escaped}\` (\`credential.assigned-secret\`)`);
    expect(description).not.toMatch(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/u,
    );
    for (const line of description.split("\n")) expect(line.startsWith("/"), line).toBe(false);
    expect(description.match(GITLAB_CLOSING_PATTERN)).toBeNull();
  });

  it("runs recorded locations through the same rule: an escaped name without a space is shown, the rest counted (#1807)", () => {
    // The run recorder escapes control, format and separator characters but
    // keeps spaces, so the Notes rule still decides what is shown.
    const recorded = [
      credentialFindingLocation("docs/x\n/label ~x.md", 3),
      credentialFindingLocation("docs/Closes #1.md", 3),
      credentialFindingLocation("docs/a\u202eb.md", 2),
      credentialFindingLocation("docs/guide.md", 1),
    ];
    const description = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Safe outcome",
      changedPaths: ["docs/guide.md"],
      credentialFindings: recorded.map((location) => ({
        code: "credential-like-content" as const,
        location,
        rule: "credential.assigned-secret",
      })),
    }).mergeRequestDescription;
    expect(description.slice(description.indexOf("## Notes"), description.indexOf("---"))).toBe(
      [
        "## Notes",
        "",
        `- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** \`${String.raw`docs/a\u202eb.md:2`}\` (\`credential.assigned-secret\`), \`docs/guide.md:1\` (\`credential.assigned-secret\`)`,
        "- 2 more findings in file names that cannot be shown safely here; the run record lists them.",
        "",
        "",
      ].join("\n"),
    );
    expect(description.match(GITLAB_CLOSING_PATTERN)).toBeNull();
    for (const line of description.split("\n")) expect(line.startsWith("/"), line).toBe(false);
  });

  it("keeps one line counting every finding when the description is too full to list any", () => {
    const { plan, changedPaths } = changedPathsForBaseLength(8_100);
    const writes = captureStderr();
    try {
      const description = buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Safe outcome",
        changedPaths,
        credentialFindings: NOTES_FILL_FINDINGS,
      }).mergeRequestDescription;
      expect(description.length).toBeLessThanOrEqual(8_192);
      expect(description.slice(description.indexOf("## Notes"), description.indexOf("---"))).toBe(
        COUNT_ONLY_NOTES,
      );
      // The run record lacks the builder's own field findings, so standard
      // error names every finding the count line covers.
      expect(writes).toEqual([NOTES_FILL_STDERR_LINE]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("uses the count line when it brings the description to exactly the bound", () => {
    const calibration = changedPathsForBaseLength(8_100);
    const overhead =
      buildDocsFabPublicationMetadata({
        plan: calibration.plan,
        workflowOutcome: "Safe outcome",
        changedPaths: calibration.changedPaths,
        credentialFindings: NOTES_FILL_FINDINGS,
      }).mergeRequestDescription.length - 8_100;
    const { plan, changedPaths } = changedPathsForBaseLength(8_192 - overhead);
    const writes = captureStderr();
    try {
      const description = buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Safe outcome",
        changedPaths,
        credentialFindings: NOTES_FILL_FINDINGS,
      }).mergeRequestDescription;
      expect(description.length).toBe(8_192);
      expect(description.slice(description.indexOf("## Notes"), description.indexOf("---"))).toBe(
        COUNT_ONLY_NOTES,
      );
      expect(writes).toEqual([NOTES_FILL_STDERR_LINE]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("writes every finding to one escaped stderr line when not even the count fits", () => {
    const { plan, changedPaths } = changedPathsForBaseLength(8_150);
    const writes = captureStderr();
    try {
      const description = buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Safe outcome",
        changedPaths,
        credentialFindings: NOTES_FILL_FINDINGS,
      }).mergeRequestDescription;
      expect(description.length).toBe(8_150);
      expect(description).not.toContain("## Notes");
      expect(writes).toEqual([NOTES_FILL_STDERR_LINE]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("names an Authorization header phrase in the workflow outcome as a finding, never refusing it", () => {
    const outcome = ["Explain the Authorization", " header for the API page"].join(":");
    const description = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: outcome,
      changedPaths: ["docs/guide.md"],
    }).mergeRequestDescription;
    expect(description).toContain(
      "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `publication:workflowOutcome` (`credential.authorization-header`)",
    );
  });

  it("strips only the run title prefix, so the explicit-composition prefix stays bracketed text and refuses", () => {
    expect(() =>
      buildDocsFabPublicationMetadata({
        plan: makePlan(),
        workflowOutcome: "[DocsFab] Improve docs",
        changedPaths: ["docs/guide.md"],
      }),
    ).toThrow("DocsFab publication metadata rejected.");
    expect(
      buildDocsFabPublicationMetadata({
        plan: makePlan(),
        workflowOutcome: "[DocsFab Run] Improve docs",
        changedPaths: ["docs/guide.md"],
      }).mergeRequestTitle,
    ).toBe("Draft: [DocsFab Run] Improve docs");
  });

  it.each([
    ["Improve governed documentation", "Draft: [DocsFab Run] Improve governed documentation"],
    ["  Improve\u00a0  governed docs  ", "Draft: [DocsFab Run] Improve governed docs"],
    ["Draft: [DocsFab Run] DocsFab: Improve docs", "Draft: [DocsFab Run] Improve docs"],
    ["wip: [docsfab run] Résumé 🚀", "Draft: [DocsFab Run] Résumé 🚀"],
    ["", "Draft: [DocsFab Run] Governed documentation update"],
    ["   ", "Draft: [DocsFab Run] Governed documentation update"],
    ["Draft: [DocsFab Run]", "Draft: [DocsFab Run] Governed documentation update"],
    ["Re\u0301sume\u0301 docs", "Draft: [DocsFab Run] Résumé docs"],
  ])("normalizes a safe bounded MR summary from %j", (workflowOutcome, expected) => {
    const metadata = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome,
      changedPaths: ["docs/guide.md"],
    });
    expect(metadata.mergeRequestTitle).toBe(expected);
    expect(metadata.mergeRequestTitle.match(/\[DocsFab Run\]/gu)).toHaveLength(1);
    expect(metadata.mergeRequestDescription).toContain("## Situation");
    expect(metadata.mergeRequestDescription).toContain("## Published by DocsFab");
    expect(metadata.mergeRequestDescription).toContain(metadata.mergeRequestProvenanceMarker);
  });

  it("derives Result and title from sealed productOutcome, not catalog alone (#246)", () => {
    const catalog = "A focused documentation patch grounded in an audit.";
    const productOutcome = {
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
      evidence: [{ id: "step:apply", kind: "step", stepId: "apply", sha256: "a".repeat(64) }],
      limitations: ["structured-product-evidence-unavailable"],
      openDecisions: [],
      producedArtifacts: [],
      outcomeSha256: "b".repeat(64),
    } as const;
    const metadata = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: catalog,
      changedPaths: ["docs/guide.md"],
      productOutcome: productOutcome as never,
    });
    expect(metadata.mergeRequestDescription).toContain("## Result");
    expect(metadata.mergeRequestDescription).toContain("**Product disposition:** `inconclusive`");
    expect(metadata.mergeRequestDescription).toContain("structured-product-evidence-unavailable");
    expect(metadata.mergeRequestDescription).toContain(
      `**Catalog outcome (subtitle):** *${catalog}*`,
    );
    expect(metadata.mergeRequestTitle).toBe(
      "Draft: [DocsFab Run] inconclusive — structured-product-evidence-unavailable",
    );
    expect(metadata.mergeRequestTitle).not.toContain(catalog);
    const catalogOnly = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: catalog,
      changedPaths: ["docs/guide.md"],
    });
    expect(catalogOnly.mergeRequestDescription).toContain("**Product disposition:** `unavailable`");
    expect(catalogOnly.mergeRequestTitle).toBe(`Draft: [DocsFab Run] ${catalog}`);
  });

  it("truncates Unicode summaries without splitting code points or exceeding the title bound", () => {
    const metadata = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "🚀".repeat(160),
      changedPaths: ["docs/guide.md"],
    });
    expect([...metadata.mergeRequestTitle]).toHaveLength(120);
    expect(metadata.mergeRequestTitle.endsWith("…")).toBe(true);
    expect(metadata.mergeRequestTitle).not.toContain("�");
    const long = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Meaningful documentation outcome ".repeat(20),
      changedPaths: ["docs/guide.md"],
    });
    expect([...long.mergeRequestTitle]).toHaveLength(120);
    expect(long.mergeRequestTitle.endsWith("…")).toBe(true);
  });

  it.each([
    "[BOT] Improve docs",
    "Improve [DocsFab Run] docs",
    "Draft: [OTHER] Improve docs",
    "bad\ttext",
    "[CODEX] Improve docs",
    "Codex: Improve docs",
    "GPT-5 improved docs",
    "OpenAI generated docs",
    "Claude: Improve docs",
    "@maintainer improved docs",
  ])("rejects spoofed, competing, provider/model, or control summary %j", (workflowOutcome) => {
    expect(() =>
      buildDocsFabPublicationMetadata({
        plan: makePlan(),
        workflowOutcome,
        changedPaths: ["docs/guide.md"],
      }),
    ).toThrow();
  });

  it("requires exactly one exact versioned content-minimized provenance marker", () => {
    const plan = makePlan();
    const metadata = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Improve docs",
      changedPaths: ["docs/guide.md"],
    });
    const marker = metadata.mergeRequestProvenanceMarker;
    expect(marker).toMatch(
      /^<!-- docsfab-publication-provenance:v1 delivery=local-user plan=[a-f0-9]{64} idempotency=[a-f0-9]{64} run=[a-f0-9]{64} source=[a-f0-9]{40,64} patch=[a-f0-9]{64} -->$/u,
    );
    expect(marker).not.toContain(plan.run.id);
    expect(hasExactDocsFabPublicationProvenance(`Human prose\n\n${marker}`, marker)).toBe(true);
    expect(hasExactDocsFabPublicationProvenance("Human prose", marker)).toBe(false);
    expect(hasExactDocsFabPublicationProvenance(`${marker}\n${marker}`, marker)).toBe(false);
    expect(hasExactDocsFabPublicationProvenance(marker.replace("v1", "v2"), marker)).toBe(false);
    expect(
      hasExactDocsFabPublicationProvenance(
        `${marker}\n<!-- docsfab-publication-provenance:v2 -->`,
        marker,
      ),
    ).toBe(false);
  });

  /** A delivered run's line for one required check that could not run (#1918). */
  const requiredCheckLine = (command: string) =>
    `required check could not run: \`${command}\` (unsupported check form). Next action: run this command from the repository root, as \`AGENTS.md\` requires, before you merge this change.`;
  /** The Notes line that counts `count` withheld required-check lines of run `run-1`. */
  const withheldRequiredChecks = (count: number) =>
    count === 1
      ? "- 1 required check line is not shown here because it may hold a configured credential, a host path, a line break, or an issue reference; `docsfab runs show run-1` lists it."
      : `- ${count} required check lines are not shown here because they may hold a configured credential, a host path, a line break, or an issue reference; \`docsfab runs show run-1\` lists them.`;
  /** The Notes block of a description: from its heading to the machine footer's rule. */
  const notesOf = (description: string) =>
    description.slice(description.indexOf("## Notes"), description.indexOf("---"));

  it("lists each required check that could not run under Notes, with its Situation code (#1918)", () => {
    const line = requiredCheckLine("ruff format .");
    const description = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Improve docs",
      changedPaths: ["docs/guide.md"],
      requiredCheckLimitations: [line],
    }).mergeRequestDescription;
    expect(description).toContain(`\n## Notes\n\n- ${line}\n`);
    expect(description).toContain("- **Limitations:** `required-check-not-run`");
    // Notes are maintainer prose, above the machine footer.
    expect(description.indexOf("## Notes")).toBeLessThan(description.indexOf("\n---\n"));
    // A run whose required checks all ran has neither.
    const ran = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Improve docs",
      changedPaths: ["docs/guide.md"],
    }).mergeRequestDescription;
    expect(ran).not.toContain("## Notes");
    expect(ran).not.toContain("required-check-not-run");
  });

  it("keeps one Notes block: the required checks first, then the credential-like content findings (#1918, #1807)", () => {
    const line = requiredCheckLine("ruff format .");
    const description = buildDocsFabPublicationMetadata({
      plan: makePlan(),
      workflowOutcome: "Improve docs",
      changedPaths: ["docs/guide.md"],
      requiredCheckLimitations: [line],
      credentialFindings: [
        { code: "credential-like-content", location: "docs/a.md:3", rule: "credential.jwt" },
      ],
    }).mergeRequestDescription;
    expect(description.split("\n").filter((text) => text.startsWith("## Notes"))).toEqual([
      "## Notes",
    ]);
    expect(notesOf(description)).toBe(
      [
        "## Notes",
        "",
        `- ${line}`,
        "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `docs/a.md:3` (`credential.jwt`)",
        "",
        "",
      ].join("\n"),
    );
  });

  it("flags a credential-shaped required-check line, and counts the lines it withholds for a configured credential, a host path, or a line break (#1918, #1807)", () => {
    const shaped = requiredCheckLine(`make check TOKEN=${["glpat", "x".repeat(24)].join("-")}`);
    const shown = requiredCheckLine("ruff format .");
    try {
      const configured = plantConfiguredCredential();
      const description = buildDocsFabPublicationMetadata({
        plan: makePlan(),
        workflowOutcome: "Improve docs",
        changedPaths: ["docs/guide.md"],
        requiredCheckLimitations: [
          shaped,
          requiredCheckLine(`make check KEY=${configured}`),
          requiredCheckLine(join(homedir(), "bin", "docs-check")),
          `${requiredCheckLine("make docs")}\n/label ~published`,
          shown,
        ],
      }).mergeRequestDescription;
      // The shaped line is published and flagged by location and rule. The
      // withheld lines are counted, and never refuse the merge request.
      expect(notesOf(description)).toBe(
        [
          "## Notes",
          "",
          `- ${shaped}`,
          `- ${shown}`,
          withheldRequiredChecks(3),
          "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `publication:requiredCheckLimitations` (`credential.gitlab-token`)",
          "",
          "",
        ].join("\n"),
      );
      expect(description).not.toContain(configured);
      expect(description).not.toContain(join(homedir(), "bin"));
      expect(description).not.toContain("/label");
    } finally {
      clearPlantedCredential();
    }
  });

  it("withholds and counts a required-check line that holds an issue reference, so merging closes no issue (#1918)", () => {
    // Each instruction file as a repository writes it, through the real
    // required-check reader and the recorded limitation line.
    const remedy = requiredCheckIsolationRemedy(["darwin-docker-desktop-unavailable"]);
    const lineFor = (instruction: string, command: string) => {
      const [check, ...rest] = requiredRepositoryChecks([
        { path: instruction, text: `Run \`${command}\` before you merge.` },
      ]);
      expect(rest).toEqual([]);
      expect(check?.command).toBe(command);
      return formatRequiredCheckLimitation({
        command: check!.command,
        directory: check!.directory,
        instruction: check!.instruction,
        cause: check!.unsupportedCause ?? "isolation-unavailable",
        ...(check!.unsupportedCause === undefined ? { remedy } : {}),
      });
    };
    const control = lineFor("AGENTS.md", "make docs-check");
    const referencing = [
      lineFor("AGENTS.md", "npm run lint Closes #1"),
      lineFor("AGENTS.md", "Fixes group/other#5"),
      lineFor(
        "AGENTS.md",
        "make check Resolves https://gitlab.example.test/group/other/-/issues/7",
      ),
      lineFor("AGENTS.md", "Closes  #1, #2 and #3"),
      lineFor("AGENTS.md", "make Implements #4"),
      // The instruction file's directory and path carry the reference.
      lineFor("Fixes #9/AGENTS.md", "make docs-check"),
      // An external tracker key.
      lineFor("AGENTS.md", "make check Closes DOCS-123"),
    ];
    // Positive controls: each line, as recorded, holds a closing statement
    // GitLab acts on, and the control line holds none.
    for (const line of referencing) expect(line).toMatch(GITLAB_CLOSING_PATTERN);
    expect(control).not.toMatch(GITLAB_CLOSING_PATTERN);
    const describeLines = (lines: string[]) =>
      buildDocsFabPublicationMetadata({
        plan: makePlan(),
        workflowOutcome: "Improve docs",
        changedPaths: ["docs/guide.md"],
        requiredCheckLimitations: lines,
      }).mergeRequestDescription;
    // The control line, platform remedy included, is shown as recorded.
    expect(notesOf(describeLines([control]))).toBe(
      ["## Notes", "", `- ${control}`, "", ""].join("\n"),
    );
    for (const line of referencing) {
      const description = describeLines([line]);
      expect(description).not.toMatch(GITLAB_CLOSING_PATTERN);
      expect(notesOf(description)).toBe(
        ["## Notes", "", withheldRequiredChecks(1), "", ""].join("\n"),
      );
      expect(description).toContain("- **Limitations:** `required-check-not-run`");
    }
    // Together: the control is shown and the rest are counted on one line.
    const description = describeLines([referencing[0]!, control, ...referencing.slice(1)]);
    expect(description).not.toMatch(GITLAB_CLOSING_PATTERN);
    expect(notesOf(description)).toBe(
      ["## Notes", "", `- ${control}`, withheldRequiredChecks(referencing.length), "", ""].join(
        "\n",
      ),
    );
  });

  it("cuts Notes to the description bound and counts the lines it left out (#1918)", () => {
    const lines = Array.from({ length: 80 }, (_, index) =>
      requiredCheckLine(`make docs-check-${index}`),
    );
    // The last line looks like a credential; the cut leaves it out, so nothing flags it.
    lines[lines.length - 1] = requiredCheckLine(
      `make check TOKEN=${["glpat", "x".repeat(24)].join("-")}`,
    );
    // A withheld line is counted on its own line, whatever the cut.
    const withheld = requiredCheckLine("make docs-check Closes #12");
    const writes = captureStderr();
    try {
      const description = buildDocsFabPublicationMetadata({
        plan: makePlan(),
        workflowOutcome: "Improve docs",
        changedPaths: ["docs/guide.md"],
        requiredCheckLimitations: [withheld, ...lines],
      }).mergeRequestDescription;
      expect(description.length).toBeLessThanOrEqual(8_192);
      const shown = lines.filter((line) => description.includes(`- ${line}\n`));
      // The first lines, in order, then the count and the command that lists
      // all of them, then the withheld count: every line is shown or counted.
      expect(shown.length).toBeGreaterThan(0);
      expect(shown).toEqual(lines.slice(0, shown.length));
      expect(description).toContain(
        `- ${lines.length - shown.length} more required check lines did not fit this description; \`docsfab runs show run-1\` lists every one.\n${withheldRequiredChecks(1)}\n`,
      );
      expect(description).not.toContain("#12");
      // The cut is the smallest: one more line would pass the bound.
      expect(description.length + lines[shown.length]!.length + 3).toBeGreaterThan(8_192);
      // Only a line the description shows is flagged: no finding, listed,
      // counted, or written to standard error.
      expect(description).not.toMatch(/credential-like content/iu);
      expect(writes).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("lists every required check before any finding when the description is full, then counts the findings (#1918, #1807)", () => {
    const line = requiredCheckLine("ruff format .");
    // What the check line adds to a description: its Notes block and the
    // Situation code.
    const calibration = changedPathsForBaseLength(7_000);
    const checkOverhead =
      buildDocsFabPublicationMetadata({
        plan: calibration.plan,
        workflowOutcome: "Safe outcome",
        changedPaths: calibration.changedPaths,
        requiredCheckLimitations: [line],
      }).mergeRequestDescription.length - 7_000;
    const counted = "- 4 credential-like content findings; the run record lists them.";
    const build = (base: number) => {
      const { plan, changedPaths } = changedPathsForBaseLength(base);
      return buildDocsFabPublicationMetadata({
        plan,
        workflowOutcome: "Safe outcome",
        changedPaths,
        requiredCheckLimitations: [line],
        credentialFindings: NOTES_FILL_FINDINGS,
      }).mergeRequestDescription;
    };
    const writes = captureStderr();
    try {
      // The check line and the count line bring the description to exactly the bound.
      const full = build(8_192 - checkOverhead - counted.length - 1);
      expect(full.length).toBe(8_192);
      expect(notesOf(full)).toBe(["## Notes", "", `- ${line}`, counted, "", ""].join("\n"));
      expect(writes).toEqual([NOTES_FILL_STDERR_LINE]);
      // One character more and the count line goes; the check line stays, and
      // standard error still names every finding.
      const fuller = build(8_192 - checkOverhead - counted.length);
      expect(fuller.length).toBe(8_192 - counted.length);
      expect(notesOf(fuller)).toBe(["## Notes", "", `- ${line}`, "", ""].join("\n"));
      expect(writes).toEqual([NOTES_FILL_STDERR_LINE, NOTES_FILL_STDERR_LINE]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("publishes without Notes when not even the count of required checks fits, keeping the Situation code (#1918)", () => {
    const line = requiredCheckLine("ruff format .");
    const calibration = changedPathsForBaseLength(7_000);
    // The Situation code alone: the check line's overhead less its Notes block.
    const situationOverhead =
      buildDocsFabPublicationMetadata({
        plan: calibration.plan,
        workflowOutcome: "Safe outcome",
        changedPaths: calibration.changedPaths,
        requiredCheckLimitations: [line],
      }).mergeRequestDescription.length -
      7_000 -
      ["## Notes", "", `- ${line}`, ""].join("\n").length -
      1;
    expect(situationOverhead).toBeGreaterThan(0);
    const { plan, changedPaths } = changedPathsForBaseLength(8_192 - situationOverhead);
    const description = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Safe outcome",
      changedPaths,
      requiredCheckLimitations: [line],
    }).mergeRequestDescription;
    expect(description.length).toBe(8_192);
    expect(description).not.toContain("## Notes");
    expect(description).toContain("- **Limitations:** `required-check-not-run`");
  });

  it("renders an immutable aggregate-bound composition title, warning, and markers", () => {
    const plan = makePlan();
    const compositionExecution = compositionPublicationBinding();
    const metadata = buildDocsFabPublicationMetadata({
      plan,
      workflowOutcome: "Improve docs",
      changedPaths: ["docs/guide.md"],
      compositionExecution,
    });
    expect(metadata.mergeRequestTitle).toBe("Draft: [DocsFab] COMPOSITION — Improve docs");
    expect(metadata.commitMessage).not.toContain("DocsFab-Execution-Mode");
    expect(metadata.commitMessage).toContain(
      `DocsFab-Composition: ${compositionExecution.compositionId}`,
    );
    expect(metadata.commitMessage).toContain(
      `DocsFab-Composition-Aggregate-SHA256: ${compositionExecution.aggregateSha256}`,
    );
    expect(metadata.mergeRequestDescription).toContain(
      "Composition-path execution evidence only. Technical approval and role qualification are not established.",
    );
    expect(metadata.mergeRequestDescription).toContain("**Release eligible:** `false`");
    expect(metadata.mergeRequestProvenanceMarker).toContain(
      ` execution=${compositionExecution.aggregateSha256} -->`,
    );
    expect(metadata.mergeRequestCompositionMarker).toBe(
      buildDocsFabCompositionExecutionMarker(compositionExecution),
    );
    expect(metadata.mergeRequestCompositionMarker).toBe(
      `<!-- docsfab-composition-execution:v1 composition=${compositionExecution.compositionId} evidence=${compositionExecution.evidenceSha256} aggregate=${compositionExecution.aggregateSha256} technical-approval=not-established role-qualification=not-established release-eligible=false -->`,
    );
    // A stored binding that still carries the deleted mode field no longer decodes.
    expect(() =>
      buildDocsFabCompositionExecutionMarker({ ...compositionExecution, mode: "legacy" } as never),
    ).toThrow("DocsFab publication metadata rejected.");
    expect(
      hasExactDocsFabPublicationMetadata(
        metadata.mergeRequestTitle,
        metadata.mergeRequestDescription,
        metadata,
      ),
    ).toBe(true);

    for (const changed of [
      { title: "Draft: [DocsFab] Improve docs", description: metadata.mergeRequestDescription },
      {
        title: metadata.mergeRequestTitle,
        description: metadata.mergeRequestDescription.replace(
          metadata.mergeRequestCompositionWarning!,
          "Composition warning removed.",
        ),
      },
      {
        title: metadata.mergeRequestTitle,
        description: metadata.mergeRequestDescription.replace(
          metadata.mergeRequestCompositionMarker!,
          metadata.mergeRequestCompositionMarker!.replace(
            "aggregate=",
            `aggregate=${"0".repeat(64)}`,
          ),
        ),
      },
    ]) {
      expect(hasExactDocsFabPublicationMetadata(changed.title, changed.description, metadata)).toBe(
        false,
      );
    }
  });

  it("derives composition publication only from the ready attestation", async () => {
    const fixture = inputs();
    const compositionExecution = compositionPublicationBinding();
    const readyAttestation = {
      ...fixture.input.readyAttestation,
      metadata: publicationMetadataInputDigests(
        fixture.input.workflowOutcome,
        fixture.input.changedPaths,
        compositionExecution,
      ),
    };
    const compositionInput = {
      ...fixture.input,
      readyAttestation,
    };
    const opened = await publishLocalUserGitLab(compositionInput, fixture.dependencies);
    expect(opened.status).toBe("opened");
    expect(fixture.gitlab.requests[0]?.title).toBe(
      "Draft: [DocsFab] COMPOSITION — Improve governed documentation",
    );

    const legacy = inputs();
    const legacyOpened = await publishLocalUserGitLab(
      { ...legacy.input, compositionExecution } as never,
      legacy.dependencies,
    );
    expect(legacyOpened.status).toBe("opened");
    expect(legacy.gitlab.requests[0]?.title).toBe(
      "Draft: [DocsFab Run] Improve governed documentation",
    );
    expect(legacy.gitlab.requests[0]?.description).not.toContain("docsfab-composition-execution");
  });

  it("rejects a stripped or substituted execution attestation projection", async () => {
    const compositionExecution = compositionPublicationBinding();
    for (const mutation of ["stripped", "substituted"] as const) {
      const fixture = inputs();
      const metadata = publicationMetadataInputDigests(
        fixture.input.workflowOutcome,
        fixture.input.changedPaths,
        compositionExecution,
      );
      const changedMetadata =
        mutation === "stripped"
          ? { ...metadata, compositionAggregateSha256: undefined }
          : { ...metadata, compositionAggregateSha256: "0".repeat(64) };
      await expect(
        publishLocalUserGitLab(
          {
            ...fixture.input,
            readyAttestation: {
              ...fixture.input.readyAttestation,
              metadata: changedMetadata,
            },
          },
          fixture.dependencies,
        ),
      ).rejects.toMatchObject({ code: "invalid-input" });
      expect(fixture.store.record).toBeUndefined();
    }
  });

  it.each(["title", "warning", "marker"] as const)(
    "refuses to adopt a composition MR after its %s is stripped or replaced",
    async (part) => {
      const fixture = inputs();
      const compositionExecution = compositionPublicationBinding();
      const input = {
        ...fixture.input,
        readyAttestation: {
          ...fixture.input.readyAttestation,
          metadata: publicationMetadataInputDigests(
            fixture.input.workflowOutcome,
            fixture.input.changedPaths,
            compositionExecution,
          ),
        },
      };
      const first = await publishLocalUserGitLab(input, fixture.dependencies);
      expect(first.status).toBe("opened");
      const request = fixture.gitlab.requests[0]!;
      const metadata = buildDocsFabPublicationMetadata({
        plan: input.plan,
        workflowOutcome: input.workflowOutcome,
        changedPaths: input.changedPaths,
        compositionExecution,
      });
      fixture.gitlab.requests = [
        {
          ...request,
          ...(part === "title" ? { title: "Draft: [DocsFab] Improve docs" } : {}),
          ...(part === "warning"
            ? {
                description: request.description!.replace(
                  metadata.mergeRequestCompositionWarning!,
                  "Warning removed.",
                ),
              }
            : {}),
          ...(part === "marker"
            ? {
                description: request.description!.replace(
                  metadata.mergeRequestCompositionMarker!,
                  "<!-- docsfab-composition-execution:v2 -->",
                ),
              }
            : {}),
        },
      ];
      const replay = await publishLocalUserGitLab(input, fixture.dependencies);
      expect(replay).toMatchObject({
        status: "failed",
        code: "merge-request-changed",
        lastConfirmedState: "opened",
      });
      expect(fixture.gitlab.creates).toBe(1);
    },
  );

  it("rejects caller metadata that is not bound by the ready worktree attestation", async () => {
    const fixture = inputs();
    await expect(
      publishLocalUserGitLab(
        {
          ...fixture.input,
          workflowOutcome: "Different governed documentation",
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fixture.store.record).toBeUndefined();
  });

  it("writes delivery worktree paths repository-relative in the MR and commit", async () => {
    const worktreePath = "/delivery/capsule/worktree";
    const fixture = inputs({ workflowOutcome: `Improve ${worktreePath}/docs/guide.md` });
    const git = new CommitMessageGit();
    const result = await publishLocalUserGitLab(fixture.input, { ...fixture.dependencies, git });
    expect(result.status).toBe("opened");
    const request = fixture.gitlab.requests[0]!;
    expect(request.title).toContain("Improve docs/guide.md");
    expect(git.commitMessages).toHaveLength(1);
    for (const text of [request.title, request.description, ...git.commitMessages]) {
      expect(text).not.toContain(worktreePath);
    }
  });

  it("keeps the startup public-roots declaration for the delivery worktree's roots", async () => {
    const home = "/srv/delivery-roots/home/node";
    const worktreePath = "/delivery/capsule/worktree";
    try {
      vi.stubEnv("HOME", home);
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", home);
      validateStartupPublicRoots();
      // A later value is not a new declaration.
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative");
      const fixture = inputs({
        workflowOutcome: `Improve ${worktreePath}/docs/guide.md from ${home}/notes.md`,
      });
      const result = await publishLocalUserGitLab(fixture.input, fixture.dependencies);
      expect(result.status).toBe("opened");
      expect(fixture.gitlab.requests[0]!.description).toContain(
        `Improve docs/guide.md from ${home}/notes.md`,
      );
    } finally {
      vi.unstubAllEnvs();
      resetStartupPublicRootsForTest();
    }
  });
});

class CommitMessageGit extends FakeGit {
  public readonly commitMessages: string[] = [];
  public override async ensureCommit(input?: { commitMessage: string }): Promise<string> {
    if (input) this.commitMessages.push(input.commitMessage);
    return super.ensureCommit();
  }
}

function inputs(options: { expiresAt?: string; workflowOutcome?: string } = {}) {
  const workflowOutcome = options.workflowOutcome ?? "Improve governed documentation";
  const plan = makeCurrentPlan();
  const authorization = authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: plan.sha256,
    command: "publish",
    currentTime: NOW,
    expiresAt: options.expiresAt ?? "2026-08-04T13:00:00.000Z",
  });
  const store = new MemoryStore();
  const git = new FakeGit();
  const gitlab = new FakeGitLab();
  const documentationResults = plan.documentationValidation!.checkIds.map((id) => ({
    id,
    status: "passed" as const,
  }));
  const documentationResult = documentationResultSha256(
    plan.documentationValidation!,
    documentationResults,
  );
  const worktree = {
    schemaVersion: 1,
    kind: "docsfab-delivery-worktree-capability",
    runId: plan.run.id,
    planSha256: plan.sha256,
    repositoryPath: "/source",
    capsulePath: "/delivery/capsule",
    worktreePath: "/delivery/capsule/worktree",
    patchPath: "/delivery/capsule/patch.diff",
    branch: plan.proposedSourceBranch,
    baseRevision: BASE,
    patchSha256: plan.patch.sha256,
    changedFilesSha256: "8".repeat(64),
    state: "ready",
  } satisfies DeliveryWorktreeCapability;
  const readyAttestation = {
    schemaVersion: 1,
    kind: "docsfab-delivery-worktree-ready-attestation",
    runId: plan.run.id,
    planSha256: plan.sha256,
    worktreePath: worktree.worktreePath,
    baseRevision: BASE,
    tree: TREE,
    workspaceKey: "9".repeat(64),
    patch: { sha256: plan.patch.sha256, byteLength: plan.patch.byteLength },
    validation: {
      commandSha256: createHash("sha256").update(plan.validationCommand).digest("hex"),
      stateSha256: "2".repeat(64),
      profileId: plan.documentationValidation!.profileId,
      profileVersion: plan.documentationValidation!.profileVersion,
      checkIds: [...plan.documentationValidation!.checkIds],
      selectorInputSha256: plan.documentationValidation!.selectorInputSha256,
      validatorIdentity: plan.documentationValidation!.validatorIdentity,
      applicabilitySha256: plan.documentationValidation!.applicabilitySha256,
      candidateTreeSha256: "3".repeat(64),
      checkSetSha256: plan.documentationValidation!.checkSetSha256,
      resultSha256: documentationResult,
      results: documentationResults,
    },
    metadata: publicationMetadataInputDigests(workflowOutcome, ["docs/guide.md"]),
  } satisfies DeliveryWorktreeReadyAttestation;
  return {
    store,
    git,
    gitlab,
    input: {
      plan,
      authorization,
      worktree,
      readyAttestation,
      receiptStore: store,
      workflowOutcome,
      changedPaths: ["docs/guide.md"],
    },
    dependencies: {
      git,
      gitlab,
      clock: () => new Date(NOW),
      assertReady: async () => undefined,
      readPatch: async () => Buffer.from("patch"),
    },
  };
}

/**
 * GitLab's default issue closing pattern (`issue_closing_pattern` in
 * gitlab.yml), ported to JavaScript, with an issue reference that covers
 * local and cross-project references and issue URLs. GitLab applies it to the
 * raw description, so a match in a code span still closes the issue.
 */
const GITLAB_ISSUE_REFERENCE = String.raw`(?:https?:\/\/\S+\/-\/(?:issues|work_items)\/\d+|(?:[\w.\-]+(?:\/[\w.\-]+)*)?#\d+)`;
const GITLAB_CLOSING_PATTERN = new RegExp(
  String.raw`\b((?:[Cc]los(?:e[sd]?|ing)|\b[Ff]ix(?:e[sd]|ing)?|\b[Rr]esolv(?:e[sd]?|ing)|\b[Ii]mplement(?:s|ed|ing)?)(:?) +(?:(?:issues? +)?${GITLAB_ISSUE_REFERENCE}(?:(?: *,? +and +| *,? *)?)|([A-Z][A-Z0-9_]+-\d+))+)`,
  "u",
);

/** One showable finding and three a file name makes unsafe to show. */
const NOTES_FILL_FINDINGS = [
  { code: "credential-like-content" as const, location: "docs/safe.md:1", rule: "credential.jwt" },
  { code: "credential-like-content" as const, location: "docs/a`b.md:2", rule: "credential.jwt" },
  {
    code: "credential-like-content" as const,
    location: "docs/tab\there.md:3",
    rule: "credential.jwt",
  },
  {
    code: "credential-like-content" as const,
    location: "docs/x\n/label ~x.md:4",
    rule: "credential.jwt",
  },
];

/** The Notes block that only counts the four `NOTES_FILL_FINDINGS`. */
const COUNT_ONLY_NOTES =
  "## Notes\n\n- 4 credential-like content findings; the run record lists them.\n\n";
/** The one stderr line naming every `NOTES_FILL_FINDINGS` entry, unsafe ones escaped. */
const NOTES_FILL_STDERR_LINE =
  'docsfab: credential-like-content flagged for maintainers; DocsFab did not remove it: "docs/a`b.md:2" ("credential.jwt"), docs/safe.md:1 (credential.jwt), "docs/tab\\there.md:3" ("credential.jwt"), "docs/x\\n/label ~x.md:4" ("credential.jwt")\n';

/** Collect standard error writes until `vi.restoreAllMocks()`. */
function captureStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

/** `makePlan()` with a patch that changes `changedFileCount` files. */
function makePlanWithChangedFiles(changedFileCount: number): LocalUserPublicationPlanV1 {
  const { sha256: _sha256, ...candidate } = makePlan();
  const changed = { ...candidate, patch: { ...candidate.patch, changedFileCount } };
  return { ...changed, sha256: localUserPublicationPlanSha256(changed as never) };
}

/**
 * A plan and 100 changed paths whose description, without a Notes block, is
 * exactly `target` characters long: every path is widened by the same amount,
 * and the first path takes the remainder.
 */
function changedPathsForBaseLength(target: number): {
  plan: LocalUserPublicationPlanV1;
  changedPaths: string[];
} {
  const plan = makePlanWithChangedFiles(100);
  const paths = (width: number, extra: number) =>
    Array.from(
      { length: 100 },
      (_item, index) =>
        `docs/generated/${String(index).padStart(3, "0")}-${"p".repeat(index === 0 ? width + extra : width)}.md`,
    );
  const length = (changedPaths: string[]) =>
    buildDocsFabPublicationMetadata({ plan, workflowOutcome: "Safe outcome", changedPaths })
      .mergeRequestDescription.length;
  const unit = length(paths(2, 0)) - length(paths(1, 0));
  const width = 1 + Math.floor((target - length(paths(1, 0))) / unit);
  const changedPaths = paths(width, target - length(paths(width, 0)));
  expect(length(changedPaths)).toBe(target);
  return { plan, changedPaths };
}

function makePlan(): LocalUserPublicationPlanV1 {
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
    baseRevision: BASE,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-1",
    patch: {
      format: "git-diff",
      sha256: createHash("sha256").update("patch").digest("hex"),
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
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate as never) };
}

function makeCurrentPlan(): LocalUserPublicationPlanV2 {
  const documentationValidation = selectDocumentationValidationProfile({
    workflow: "update-documentation",
    changedPaths: ["docs/guide.md"],
    hostPolicySha256: validationBackendPolicySha256(),
    applicabilitySha256: "5".repeat(64),
  }).binding;
  const { schemaVersion: _schemaVersion, sha256: _sha256, ...legacy } = makePlan();
  const candidate = {
    ...legacy,
    schemaVersion: 2 as const,
    validationCommand: "test -d .",
    documentationValidation,
  };
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate) };
}

function documentationResultSha256(
  binding: NonNullable<LocalUserPublicationPlan["documentationValidation"]>,
  results: readonly { id: string; status: "passed" }[],
  stateSha256 = "2".repeat(64),
  candidateTreeSha256 = "3".repeat(64),
): string {
  return documentationValidationKit.canonicalDigest({
    results,
    stateSha256,
    checkSetSha256: binding.checkSetSha256,
    candidateTreeSha256,
    ...(binding.schemaVersion === 2 ? { applicabilitySha256: binding.applicabilitySha256 } : {}),
  });
}

function compositionPublicationBinding() {
  return createCompositionPublicationBinding({
    compositionId: "openai-gpt-5.6-sol-pi",
    evidenceSha256: "e".repeat(64),
    aggregateSha256: "f".repeat(64),
  });
}

async function durableProcessFixture(): Promise<{
  configPath: string;
  markerPath: string;
  idempotencyKey: string;
  store: FileScmDeliveryReceiptStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-publisher-process-"));
  publisherTemporary.push(root);
  const receiptRoot = join(root, "receipts");
  const markerPath = join(root, "mr-posts.log");
  const mergeRequestPath = join(root, "merge-request.json");
  const configPath = join(root, "config.json");
  const fixture = inputs();
  const store = new FileScmDeliveryReceiptStore(receiptRoot);
  let record = createScmDeliveryRecord({
    plan: fixture.input.plan,
    authorization: fixture.input.authorization,
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  await store.claim(record);
  const transitions = [
    {
      toState: "prepared" as const,
      at: "2026-08-04T12:00:01.000Z",
      evidence: { workspaceKey: fixture.input.readyAttestation.workspaceKey, baseRevision: BASE },
    },
    {
      toState: "validated" as const,
      at: "2026-08-04T12:00:02.000Z",
      evidence: {
        commandSha256: fixture.input.readyAttestation.validation.commandSha256,
        summarySha256: fixture.input.readyAttestation.validation.stateSha256,
        checkCount: fixture.input.plan.documentationValidation!.checkIds.length,
        profileId: fixture.input.plan.documentationValidation!.profileId,
        profileVersion: fixture.input.plan.documentationValidation!.profileVersion,
        checkIds: [...fixture.input.plan.documentationValidation!.checkIds],
        selectorInputSha256: fixture.input.plan.documentationValidation!.selectorInputSha256,
        validatorIdentity: fixture.input.plan.documentationValidation!.validatorIdentity,
        applicabilitySha256: fixture.input.plan.documentationValidation!.applicabilitySha256,
        candidateTreeSha256: "3".repeat(64),
        checkSetSha256: fixture.input.plan.documentationValidation!.checkSetSha256,
        resultSha256: fixture.input.readyAttestation.validation.resultSha256!,
        results: fixture.input.readyAttestation.validation.results!,
      },
    },
    {
      toState: "committed" as const,
      at: "2026-08-04T12:00:03.000Z",
      evidence: { sha: COMMIT },
    },
    {
      toState: "pushed" as const,
      at: "2026-08-04T12:00:04.000Z",
      evidence: { remoteRevision: COMMIT },
    },
  ];
  for (const transition of transitions) {
    const next = recordScmDeliveryProgress(
      record,
      {
        ...transition,
        source: "executed",
      },
      fixture.input.plan,
      fixture.input.authorization,
    );
    await store.compareAndSwap(record.sha256, next);
    record = next;
  }
  await writeFile(
    configPath,
    `${JSON.stringify({
      receiptRoot,
      markerPath,
      mergeRequestPath,
      plan: fixture.input.plan,
      worktree: fixture.input.worktree,
      readyAttestation: fixture.input.readyAttestation,
    })}\n`,
    { mode: 0o600 },
  );
  return { configPath, markerPath, idempotencyKey: record.idempotencyKey, store };
}

function publisherProcess(
  configPath: string,
  mode: "normal" | "crash-before-post" | "crash-after-post",
): Promise<void> {
  const source = String.raw`
    import { appendFile, readFile, writeFile } from "node:fs/promises";
    import {
      FileScmDeliveryReceiptStore,
      authorizeLocalUserPublication,
      buildDocsFabPublicationMetadata,
      publishLocalUserGitLab,
    } from "./src/delivery/index.ts";
    const [configPath, mode] = process.argv.slice(1);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const authorization = authorizeLocalUserPublication({
      plan: config.plan,
      confirmedPlanSha256: config.plan.sha256,
      command: "publish",
      currentTime: new Date("2026-08-04T12:00:00.000Z"),
      expiresAt: "2026-08-04T13:00:00.000Z",
    });
    const metadata = buildDocsFabPublicationMetadata({
      plan: config.plan,
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
    });
    const exactRequest = () => ({
      iid: 7,
      url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
      state: "opened",
      draft: true,
      sourceBranch: config.plan.proposedSourceBranch,
      targetBranch: config.plan.targetBranch.name,
      headRevision: "${COMMIT}",
      sourceProjectId: config.plan.project.id,
      targetProjectId: config.plan.project.id,
      title: metadata.mergeRequestTitle,
      description: metadata.mergeRequestDescription,
    });
    const git = {
      assertConfiguredIdentity: async () => undefined,
      localBranchRevision: async () => "${COMMIT}",
      remoteBranchRevision: async () => "${COMMIT}",
      ensureCommit: async () => "${COMMIT}",
      ensurePush: async () => "${COMMIT}",
      assertCommit: async () => undefined,
    };
    const gitlab = {
      inspectPolicy: async () => ({
        username: "maintainer",
        projectId: config.plan.project.id,
        projectPath: config.plan.project.path,
        accessLevel: 30,
        defaultBranch: "main",
        targetBranch: { name: "main", protected: true, revision: config.plan.baseRevision },
        sourceBranchProtected: false,
      }),
      findMergeRequests: async () => {
        try { return [JSON.parse(await readFile(config.mergeRequestPath, "utf8"))]; }
        catch (error) { if (error?.code === "ENOENT") return []; throw error; }
      },
      openDraftMergeRequest: async () => {
        if (mode === "crash-before-post") process.kill(process.pid, "SIGKILL");
        const request = exactRequest();
        await appendFile(config.markerPath, "post\n");
        await writeFile(config.mergeRequestPath, JSON.stringify(request) + "\n", { mode: 0o600 });
        if (mode === "crash-after-post") process.kill(process.pid, "SIGKILL");
        return request;
      },
    };
    const result = await publishLocalUserGitLab({
      plan: config.plan,
      authorization,
      worktree: config.worktree,
      readyAttestation: config.readyAttestation,
      receiptStore: new FileScmDeliveryReceiptStore(config.receiptRoot),
      workflowOutcome: "Improve governed documentation",
      changedPaths: ["docs/guide.md"],
    }, {
      git,
      gitlab,
      clock: () => new Date("2026-08-04T12:00:10.000Z"),
      assertReady: async () => undefined,
    });
    if (result.status !== "opened") throw new Error("publisher did not open");
  `;
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source, configPath, mode],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    child.once("error", rejectProcess);
    child.once("close", (code, signal) => {
      if (code === 0) resolveProcess();
      else
        rejectProcess(
          new Error(
            `publisher process failed (${code ?? signal ?? "unknown"}): ${Buffer.concat(output).toString("utf8")}`,
          ),
        );
    });
  });
}

async function postCount(markerPath: string): Promise<number> {
  try {
    return (await readFile(markerPath, "utf8")).split("\n").filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
