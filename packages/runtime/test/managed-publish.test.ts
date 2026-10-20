// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { recordRunTaskLineage } from "../src/lineage/index.js";
import {
  createAutoAssessment,
  createAutoCycleRequest,
  createAutoWorkflowTaskBinding,
  createWorkflowCandidate,
  createWorkflowDecision,
} from "./support/autonomy-contracts.js";
import {
  createHostAuthorityCycleMint,
  createHostAuthorityLineageMint,
  type AutoCycleOnceRecordV1,
} from "../src/autonomy/once.js";
import { ManagedCycleError } from "../src/autonomy/managed-cycle.js";
import type {
  ManagedCycleOnceHost,
  ManagedIssueSelectionCandidateInputV1,
  ManagedIssueSelectionInputV1,
} from "../src/autonomy/managed-cycle.js";
import {
  ManagedCyclePublishError,
  runManagedCyclePublishOnce,
} from "../src/autonomy/managed-publish.js";
import type {
  ManagedCyclePublishAttemptV1,
  ManagedCyclePublishHost,
  ManagedCyclePublishRecordV1,
} from "../src/autonomy/managed-publish.js";
import {
  createProductionManagedPublish,
  mintHostJobEnvelope,
  requireHostMintedEnvelope,
  requirePublishableWritePatch,
  submitAfterSucceededRun,
  EmptyPublishableWriteError,
  type HostJobEnvelopeV1,
} from "../src/autonomy/managed-publish-host.js";

const IDENTITY = "1".repeat(64);
const REVISION = "a".repeat(40);
const TRACKER = "3".repeat(64);
const FINDING_SHA = "4".repeat(64);
const FINGERPRINT = "5".repeat(64);
const EVIDENCE = "6".repeat(64);
const ASSIGNEE = "c".repeat(64);
const REPOSITORY = { identitySha256: IDENTITY, revision: REVISION };
const BASE = Date.parse("2026-08-07T12:00:00.000Z");
const PUBLISHABLE_CHANGES = {
  files: [{ path: "docs/page.md", status: "modified" as const }],
  patch: {
    sha256: "b".repeat(64),
    byteLength: 32,
    lineCount: 4,
    artifactPath: "/tmp/run.patch",
    format: "git-diff" as const,
  },
};

function baseCandidate(
  iid: number,
  seed: string,
  overrides: Partial<ManagedIssueSelectionCandidateInputV1> = {},
): ManagedIssueSelectionCandidateInputV1 {
  return {
    issueIid: iid,
    markerIdentityDigest: seed.repeat(64),
    gate: "g1",
    workflow: "content-repair",
    priority: "p1",
    lifecycle: "ready",
    confidence: "confirmed",
    dependencyReadiness: "ready",
    pathCollision: "none",
    validationCost: 1,
    requiredHumanInputOpen: false,
    testedRevision: REVISION,
    ...overrides,
  };
}

function selectionInput(
  candidates: ManagedIssueSelectionCandidateInputV1[],
): ManagedIssueSelectionInputV1 {
  return {
    cycleId: "cycle:once-fixture",
    repository: REPOSITORY,
    trackerObservationSha256: TRACKER,
    candidates,
  };
}

function managedChain(deliveryMode: "local-patch" | "local-user-gitlab") {
  const repository = { identitySha256: IDENTITY, revision: REVISION };
  const binding = createAutoWorkflowTaskBinding("create-documentation", null, repository);
  const stepIds = getWorkflow("create-documentation").steps.map((step) => step.id);
  const request = createAutoCycleRequest({
    cycleId: "cycle:once-fixture",
    repository,
    tracker: {
      projectIdentitySha256: "2".repeat(64),
      observationSha256: "3".repeat(64),
      observedAt: "2026-08-07T11:59:00.000Z",
      authority: "observe-only",
    },
    maturityFindingSha256s: [FINDING_SHA],
    bounds: {
      workflowNames: ["create-documentation"],
      pathClass: "documentation-write",
      pathPrefixes: ["docs"],
      targetBranch: "main",
      deliveryMode,
      requiredValidationIds: ["docs-build"],
      workflowPrerequisites: [
        { workflow: "create-documentation", prerequisiteIds: ["scaffold-ready"] },
      ],
      workflowTasks: [binding],
    },
  });
  const candidate = createWorkflowCandidate(
    {
      id: "candidate:create-documentation",
      taskSha256: binding.taskSha256,
      workflow: "create-documentation",
      stepIds,
      prerequisites: [{ id: "scaffold-ready", state: "satisfied", evidenceSha256s: [EVIDENCE] }],
      maturityFindingFingerprints: [FINGERPRINT],
      pathClass: "documentation-write",
      pathPrefixes: ["docs"],
      deliveryMode,
      validationIds: ["docs-build"],
    },
    request,
  );
  const { schemaVersion: _s, kind: _k, candidateSha256: _c, ...candidateInput } = candidate;
  const assessment = createAutoAssessment(
    {
      requestSha256: request.requestSha256,
      repository: request.repository,
      trackerObservationSha256: request.tracker.observationSha256,
      evidenceState: "sufficient",
      maturityFindings: [
        {
          fingerprint: FINGERPRINT,
          findingSha256: FINDING_SHA,
          confidence: "confirmed",
          disposition: "observed-absence",
        },
      ],
      candidates: [candidateInput],
      openInputIds: [],
    },
    request,
  );
  const decision = createWorkflowDecision(
    {
      disposition: "execute",
      candidateSha256: assessment.candidates[0]!.candidateSha256,
      reasonCode: "eligible-candidate-selected",
    },
    request,
    assessment,
  );
  return { request, assessment, decision, repository };
}

function succeededRun(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-once-fixture",
    workflow: "create-documentation",
    repository: { sourcePath: "/tmp/source", requestedRevision: "HEAD", revision: REVISION },
    status: "succeeded",
  } as unknown as RunRecord;
}

function publicationResult(targetBranch: string, iid = 42) {
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-local-user-gitlab-publication-result" as const,
    status: "opened" as const,
    planSha256: "7".repeat(64),
    idempotencyKey: "8".repeat(64),
    receiptSha256: "e".repeat(64),
    state: "opened" as const,
    disposition: "succeeded" as const,
    sourceBranch: "docsfab-run/once-fixture",
    targetBranch,
    commitRevision: REVISION,
    mergeRequest: {
      iid,
      url: `https://example.test/group/repo/-/merge_requests/${iid}`,
      draft: true as const,
      headRevision: REVISION,
    },
  };
}

function openedAttempt(targetBranch = "main", iid = 42): ManagedCyclePublishAttemptV1 {
  return { status: "opened", result: publicationResult(targetBranch, iid) };
}

function deferredAttempt(): ManagedCyclePublishAttemptV1 {
  return {
    status: "deferred",
    failureCode: "push-interrupted",
    lastConfirmedState: "committed",
    nextAction: "resume-draft-mr-publish",
    recoveryCommand: "re-run docsfab auto --publish --confirm-cycle to resume",
    patchPreserved: true,
  };
}

function baseOnceHost(): ManagedCycleOnceHost {
  const now = () => new Date(BASE);
  return {
    now,
    confirmation: {
      authorityId: "operator-local",
      operatorIdentitySha256: "c".repeat(64),
      affirmed: true as const,
    },
    mintCycle: createHostAuthorityCycleMint(now),
    mintLineage: createHostAuthorityLineageMint(now),
    execute: async (input) => {
      const record = succeededRun();
      recordRunTaskLineage(record, input.taskLineage);
      return record;
    },
    validate: async (_record, ids) =>
      ids.map((id) => ({ id, status: "passed" as const, evidenceSha256: "9".repeat(64) })),
    save: async () => undefined,
    saveLink: async () => undefined,
  };
}

interface FakeHostState {
  host: ManagedCyclePublishHost;
  store: Map<string, ManagedCyclePublishRecordV1>;
  saved: ManagedCyclePublishRecordV1[];
  publishCalls: { resume: boolean }[];
}

function buildPublishHost(
  publish: (input: { resume: boolean }) => Promise<ManagedCyclePublishAttemptV1>,
): FakeHostState {
  const store = new Map<string, ManagedCyclePublishRecordV1>();
  const saved: ManagedCyclePublishRecordV1[] = [];
  const publishCalls: { resume: boolean }[] = [];
  const host: ManagedCyclePublishHost = {
    ...baseOnceHost(),
    publish: async (input) => {
      publishCalls.push({ resume: input.resume });
      return publish({ resume: input.resume });
    },
    loadPublishRecord: async (cycleId) => store.get(cycleId) ?? null,
    savePublishRecord: async (record) => {
      store.set(record.cycleId, record);
      saved.push(record);
    },
  };
  return { host, store, saved, publishCalls };
}

function publishInput(
  deliveryMode: "local-patch" | "local-user-gitlab",
  candidates = [baseCandidate(50, "a")],
) {
  return {
    selection: selectionInput(candidates),
    assigneeIdentitySha256: ASSIGNEE,
    chain: managedChain(deliveryMode),
  };
}

describe("auto --publish: publish and resume one draft MR from a cycle (#100)", () => {
  it("opens exactly one draft MR on the happy path with a single publish", async () => {
    let createCount = 0;
    const fake = buildPublishHost(async () => {
      createCount += 1;
      return openedAttempt("main");
    });
    const outcome = await runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host);
    expect(createCount).toBe(1);
    expect(fake.publishCalls).toEqual([{ resume: false }]);
    expect(outcome.publish?.status).toBe("opened");
    expect(outcome.publish?.mergeRequest?.iid).toBe(42);
    expect(outcome.publish?.delivery?.lifecycleTarget).toBe("in-review");
    expect(fake.saved).toHaveLength(1);
  });

  it("reuses the same draft MR on a re-run without opening a duplicate", async () => {
    const fake = buildPublishHost(async () => openedAttempt("main"));
    const first = await runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host);
    const second = await runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host);
    expect(fake.publishCalls).toEqual([{ resume: false }, { resume: true }]);
    expect(first.publish?.mergeRequest?.iid).toBe(42);
    expect(second.publish?.mergeRequest?.iid).toBe(42);
    expect(second.publish?.status).toBe("opened");
  });

  it("resumes an interrupted publish from the preserved receipt on re-run", async () => {
    const attempts = [deferredAttempt(), openedAttempt("main")];
    const fake = buildPublishHost(async () => attempts.shift()!);
    const first = await runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host);
    expect(first.publish?.status).toBe("deferred");
    expect(first.publish?.failureCode).toBe("push-interrupted");
    expect(first.publish?.patchEvidencePreserved).toBe(true);
    expect(first.publish?.recoveryCommand).toContain("--publish");
    const second = await runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host);
    expect(fake.publishCalls).toEqual([{ resume: false }, { resume: true }]);
    expect(second.publish?.status).toBe("opened");
    expect(second.publish?.mergeRequest?.iid).toBe(42);
  });

  it("records a patch-preserving no-op and never publishes a local-patch cycle", async () => {
    const fake = buildPublishHost(async () => openedAttempt("main"));
    const outcome = await runManagedCyclePublishOnce(publishInput("local-patch"), fake.host);
    expect(fake.publishCalls).toHaveLength(0);
    expect(outcome.publish?.status).toBe("no-op");
    expect(outcome.publish?.mergeRequest).toBeNull();
    expect(outcome.cycle.link?.lifecycleTarget).toBe("in-progress");
  });

  it("performs no cycle and no publication when no ready issue is selected", async () => {
    const fake = buildPublishHost(async () => openedAttempt("main"));
    const outcome = await runManagedCyclePublishOnce(
      publishInput("local-user-gitlab", [baseCandidate(60, "a", { lifecycle: "blocked" })]),
      fake.host,
    );
    expect(fake.publishCalls).toHaveLength(0);
    expect(outcome.publish).toBeNull();
    expect(outcome.cycle.selection.selected).toBeNull();
  });

  it("fails closed when the published branch drifts from the authorized target", async () => {
    const fake = buildPublishHost(async () => openedAttempt("release"));
    await expect(
      runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host),
    ).rejects.toBeInstanceOf(ManagedCycleError);
  });

  it("fails closed when a resumed cycle observes a different draft MR", async () => {
    const attempts = [openedAttempt("main", 42), openedAttempt("main", 43)];
    const fake = buildPublishHost(async () => attempts.shift()!);
    await runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host);
    await expect(
      runManagedCyclePublishOnce(publishInput("local-user-gitlab"), fake.host),
    ).rejects.toBeInstanceOf(ManagedCyclePublishError);
  });
});

describe("submitAfterSucceededRun host envelope (#168 option 4, #171)", () => {
  it("fails closed when the envelope is built from simulated inner-step JSON", async () => {
    const innerStep = {
      id: "write-docs",
      kind: "inference",
      status: "succeeded",
      summary: "open a draft MR",
      payload: { write: true, publish: "draft-mr", runId: "run-once-fixture" },
    };
    expect(() => requireHostMintedEnvelope(innerStep)).toThrow(/inner-step JSON|cannot be minted/u);
    const execute = async () => {
      throw new Error("delivery must not run for inner-step JSON");
    };
    await expect(
      submitAfterSucceededRun({ id: "run-once-fixture", status: "succeeded" }, innerStep, {
        cwd: "/tmp",
        repositoryPath: "/tmp/repo",
        stateDirectory: "/tmp/state",
        execute,
        preflight: async () => {
          throw new Error("preflight must not run for inner-step JSON");
        },
      }),
    ).rejects.toThrow(/inner-step JSON|cannot be minted/u);
  });

  it("does not reuse a host grant across run ids", async () => {
    const envelope = mintHostJobEnvelope("run-a", {
      source: "cli-argv",
      allowWrite: true,
      draftMr: true,
    });
    const execute = async () => {
      throw new Error("delivery must not run for a reused grant");
    };
    await expect(
      submitAfterSucceededRun({ id: "run-b", status: "succeeded" }, envelope, {
        cwd: "/tmp",
        repositoryPath: "/tmp/repo",
        stateDirectory: "/tmp/state",
        execute,
        preflight: async () => {
          throw new Error("preflight must not run for a reused grant");
        },
      }),
    ).rejects.toThrow(/cannot be reused/u);
  });

  it("CLI --draft-mr without --allow-write cannot mint a publish envelope", () => {
    expect(() =>
      mintHostJobEnvelope("run-a", {
        source: "cli-argv",
        allowWrite: false,
        draftMr: true,
      }),
    ).toThrow(/requires --allow-write/u);
  });

  it("auto --publish confirm-cycle projection calls submitAfterSucceededRun", async () => {
    const seen: Array<{ runId: string; envelope: HostJobEnvelopeV1 }> = [];
    const publish = createProductionManagedPublish({
      cwd: "/tmp",
      repositoryPath: "/tmp/repo",
      stateDirectory: "/tmp/state",
      submit: async (run, envelope) => {
        seen.push({
          runId: run.id,
          envelope: envelope as HostJobEnvelopeV1,
        });
      },
    });
    const attempt = await publish({
      link: {
        cycleId: "cycle:once-fixture",
      } as never,
      record: {
        cycleId: "cycle:once-fixture",
        runRecordId: "run-once-fixture",
      } as AutoCycleOnceRecordV1,
      resume: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runId).toBe("run-once-fixture");
    expect(seen[0]!.envelope).toMatchObject({
      kind: "docsfab-host-job-envelope",
      write: true,
      publish: "draft-mr",
      runId: "run-once-fixture",
    });
    expect(attempt.status).toBe("deferred");
  });

  it("submitAfterSucceededRun drives local-user delivery for a host-minted draft-mr envelope", async () => {
    const envelope = mintHostJobEnvelope("run-once-fixture", {
      source: "cli-argv",
      allowWrite: true,
      draftMr: true,
    });
    const calls: { args: readonly string[] }[] = [];
    const editorialDecodeOptions = {
      decodeWorkflowBranchCoverage: vi.fn(),
      decodeEditorialDecision: vi.fn(),
    } as never;
    let preflightEditorialDecodeOptions: unknown;
    let executeEditorialDecodeOptions: unknown;
    await submitAfterSucceededRun(
      { id: "run-once-fixture", status: "succeeded", changes: PUBLISHABLE_CHANGES },
      envelope,
      {
        cwd: "/tmp",
        repositoryPath: "/tmp/repo",
        stateDirectory: "/tmp/state",
        editorialDecodeOptions,
        preflight: async (_input, _commands, options) => {
          preflightEditorialDecodeOptions = options;
          return {
            sha256: "a".repeat(64),
            validationCommand: "true",
          } as never;
        },
        execute: async (args, dependencies) => {
          calls.push({ args });
          executeEditorialDecodeOptions = dependencies.editorialDecodeOptions;
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "run-once-fixture",
      "--repo",
      "/tmp/repo",
      "--draft-mr",
      "--execute",
      "--confirm-plan-sha256",
      "a".repeat(64),
      "--state-dir",
      "/tmp/state",
      "--validation-command",
      "true",
      "--remote",
      "origin",
    ]);
    expect(calls[0]!.args.includes("--confirm-plan-sha256")).toBe(true);
    expect(preflightEditorialDecodeOptions).toBe(editorialDecodeOptions);
    expect(executeEditorialDecodeOptions).toBe(editorialDecodeOptions);
  });

  it("submitAfterSucceededRun plans with the Git environment the execute step runs (#2393)", async () => {
    const environment = { HOME: "/operator-home", PATH: "/usr/bin" };
    const seen: unknown[][] = [];
    const submit = async (executeDependencies?: { environment?: NodeJS.ProcessEnv }) => {
      await submitAfterSucceededRun(
        { id: "run-once-fixture", status: "succeeded", changes: PUBLISHABLE_CHANGES },
        mintHostJobEnvelope("run-once-fixture", {
          source: "cli-argv",
          allowWrite: true,
          draftMr: true,
        }),
        {
          cwd: "/tmp",
          repositoryPath: "/tmp/repo",
          stateDirectory: "/tmp/state",
          ...(executeDependencies
            ? {
                executeDependencies: {
                  cwd: "/tmp",
                  stateDirectory: "/tmp/state",
                  log: () => undefined,
                  ...executeDependencies,
                },
              }
            : {}),
          preflight: async (...args) => {
            seen.push(args.slice(1));
            return { sha256: "a".repeat(64), validationCommand: "true" } as never;
          },
          execute: async () => undefined,
        },
      );
    };
    await submit({ environment });
    const context = seen[0]?.[2] as { environment?: NodeJS.ProcessEnv } | undefined;
    expect(context).toEqual({ environment });
    expect(context?.environment).toBe(environment);
    // Positive control: with no environment named, preflight is called as it always was,
    // with no fourth argument.
    await submit();
    expect(seen[1]).toEqual([undefined]);
  });

  it("one-command draft-mr refuses an empty write before preflight or execute", async () => {
    expect(() =>
      requirePublishableWritePatch({ status: "succeeded", changes: { files: [] } }),
    ).toThrow(EmptyPublishableWriteError);
    expect(() =>
      requirePublishableWritePatch({
        status: "succeeded",
        changes: {
          files: [
            { path: ".docsfab.json", status: "added" },
            {
              path: ".docsfab/reference-model/knowledge-accepted-snapshot.json",
              status: "added",
            },
          ],
          patch: {
            sha256: "a".repeat(64),
            byteLength: 128,
            lineCount: 1,
            artifactPath: "/tmp/empty.patch",
            format: "git-diff",
          },
        },
      }),
    ).toThrow(EmptyPublishableWriteError);
    const envelope = mintHostJobEnvelope("run-empty", {
      source: "cli-argv",
      allowWrite: true,
      draftMr: true,
    });
    const execute = async (): Promise<undefined> => {
      throw new Error("execute must not run for an empty patch");
    };
    await expect(
      submitAfterSucceededRun(
        { id: "run-empty", status: "succeeded", changes: { files: [] } },
        envelope,
        {
          cwd: "/tmp",
          repositoryPath: "/tmp/repo",
          stateDirectory: "/tmp/state",
          execute,
          preflight: async () => {
            throw new Error("preflight must not run for an empty patch");
          },
        },
      ),
    ).rejects.toThrow(/empty patch is not published/u);
  });
});
