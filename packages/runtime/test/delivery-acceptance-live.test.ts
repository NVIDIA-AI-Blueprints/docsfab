// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeLocalUserGitLabPublicationResult,
  decodeDeliveryAcceptanceManifest,
  DELIVERY_ACCEPTANCE_EMPTY_IGNORED_STATE_SUMMARY,
  DELIVERY_ACCEPTANCE_CASE_IDS,
  finalizeDeliveryAcceptanceChainBinding,
  finalizeDeliveryAcceptanceManifest,
  localUserPublicationPlanSha256,
  runDeliveryAcceptanceCli,
  scmDeliveryIdempotencyKey,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/index.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const TESTED = "a".repeat(40);
const SOURCE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const TREE = "d".repeat(40);
const RECORD = "1".repeat(64);
const PATCH = "2".repeat(64);
const OUTCOME = "Improve the bounded documentation gap";

afterEach(async () => {
  delete process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE;
});

describe("live delivery acceptance manifest", () => {
  it("shares one closed publication-result decoder across live and offline acceptance", () => {
    const plan = publicationPlan();
    const result = {
      schemaVersion: 1,
      kind: "docsfab-local-user-gitlab-publication-result",
      status: "opened",
      planSha256: plan.sha256,
      idempotencyKey: scmDeliveryIdempotencyKey(plan),
      receiptSha256: "3".repeat(64),
      state: "opened",
      disposition: "succeeded",
      sourceBranch: plan.proposedSourceBranch,
      targetBranch: plan.targetBranch.name,
      commitRevision: COMMIT,
      mergeRequest: {
        iid: 17,
        url: "https://gitlab.example.test/group/docs/-/merge_requests/17",
        draft: true,
        headRevision: COMMIT,
      },
    };
    expect(decodeLocalUserGitLabPublicationResult(result).commitRevision).toBe(COMMIT);
    expect(() => decodeLocalUserGitLabPublicationResult({ ...result, extra: true })).toThrow();
    expect(() =>
      decodeLocalUserGitLabPublicationResult({
        ...result,
        mergeRequest: { ...result.mergeRequest, headRevision: "e".repeat(40) },
      }),
    ).toThrow();
  });

  it("rejects a self-consistent caller-authored chain without authentic private evidence", async () => {
    const root = await roots.create("docsfab-live-manifest-");
    const plan = publicationPlan();
    const chain = acceptanceChain();
    const chainPath = join(root, "chain.json");
    const matrixPath = join(root, "matrix.json");
    const chainEvidenceArgs = await privateChainEvidenceArgs(root);
    await Promise.all([
      writePrivate(chainPath, canonicalizeJsonEvidence(chain as never)),
      writePrivate(
        matrixPath,
        canonicalizeJsonEvidence(offlineMatrixManifest(chain, plan) as never),
      ),
    ]);
    let preflightCalled = false;
    process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE = "true";
    const args = [
      "--live",
      "--preflight-only",
      "--repo",
      root,
      "--run-id",
      "write-run",
      "--state-dir",
      join(root, "state"),
      "--approve-project-id",
      "42",
      "--approve-project-path",
      "group/docs",
      "--approve-action",
      "inspect-only",
      "--tested-revision",
      TESTED,
      "--chain-manifest",
      chainPath,
      "--offline-manifest",
      matrixPath,
      ...chainEvidenceArgs,
    ];
    const dependencies = {
      currentDocsFabRevision: async () => TESTED,
      preflight: async () => {
        preflightCalled = true;
        return plan;
      },
    };
    await expect(runDeliveryAcceptanceCli(args, dependencies)).rejects.toThrow();
    expect(preflightCalled).toBe(false);

    const duplicate = canonicalizeJsonEvidence(chain as never).replace(
      "{",
      '{"duplicate":1,"duplicate":1,',
    );
    await writePrivate(chainPath, duplicate);
    await expect(runDeliveryAcceptanceCli(args, dependencies)).rejects.toThrow();
    expect(preflightCalled).toBe(false);
  });

  it("assembles a successful fake live result through the shared strict decoder", async () => {
    const root = await roots.create("docsfab-live-manifest-");
    const evidenceRoot = await roots.create("docsfab-live-manifest-");
    const plan = publicationPlan();
    const idempotencyKey = scmDeliveryIdempotencyKey(plan);
    const receiptSha256 = "3".repeat(64);
    const chain = acceptanceChain();
    const matrix = offlineMatrixManifest(chain, plan);
    const chainPath = join(root, "chain.json");
    const matrixPath = join(root, "matrix.json");
    const chainEvidenceArgs = await privateChainEvidenceArgs(root);
    await Promise.all([
      writePrivate(chainPath, canonicalizeJsonEvidence(chain as never)),
      writePrivate(matrixPath, canonicalizeJsonEvidence(matrix as never)),
    ]);
    const output: string[] = [];
    let preflightCalls = 0;
    let executeCalls = 0;
    process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE = "true";
    await runDeliveryAcceptanceCli(
      [
        "--live",
        "--repo",
        root,
        "--run-id",
        "write-run",
        "--state-dir",
        join(root, "state"),
        "--evidence-dir",
        evidenceRoot,
        "--approve-project-id",
        "42",
        "--approve-project-path",
        "group/docs",
        "--approve-action",
        "open-draft-mr",
        "--confirm-plan-sha256",
        plan.sha256,
        "--delivery-root",
        join(root, "delivery"),
        "--receipt-root",
        join(root, "receipts"),
        "--tested-revision",
        TESTED,
        "--chain-manifest",
        chainPath,
        "--offline-manifest",
        matrixPath,
        ...chainEvidenceArgs,
      ],
      {
        currentDocsFabRevision: async () => TESTED,
        assembleChain: () => chain,
        sourceCheckoutSha256: async () => "a".repeat(64),
        preflight: async () => {
          preflightCalls += 1;
          return plan;
        },
        loadRun: async () => ({
          id: "write-run",
          workflow: "update-documentation",
          workflowOutcome: OUTCOME,
          recordSha256: RECORD,
          sourcePath: root,
          revision: SOURCE,
          patch: {
            sha256: PATCH,
            byteLength: 10,
            lineCount: 1,
            artifactPath: join(root, "private.patch"),
            format: "git-diff",
          },
          patchBytes: Buffer.from("0123456789"),
          changedFiles: [{ path: "docs/guide.md", status: "modified" }],
          changedFileCount: 1,
          taskLineage: null,
        }),
        execute: async (_args, dependencies) => {
          executeCalls += 1;
          dependencies.log(
            JSON.stringify({
              schemaVersion: 1,
              kind: "docsfab-local-user-gitlab-publication-result",
              status: "opened",
              planSha256: plan.sha256,
              idempotencyKey,
              receiptSha256,
              state: "opened",
              disposition: "succeeded",
              sourceBranch: plan.proposedSourceBranch,
              targetBranch: plan.targetBranch.name,
              commitRevision: COMMIT,
              mergeRequest: {
                iid: 17,
                url: "https://gitlab.example.test/group/docs/-/merge_requests/17",
                draft: true,
                headRevision: COMMIT,
              },
            }),
          );
        },
        loadReceipt: async () =>
          ({
            sha256: receiptSha256,
            state: "opened",
            disposition: "succeeded",
            planSha256: plan.sha256,
            authorization: { planSha256: plan.sha256 },
            idempotencyKey,
            evidence: {
              validation: {
                commandSha256: "e".repeat(64),
                summarySha256: "f".repeat(64),
                checkCount: 1,
              },
              commit: { sha: COMMIT },
              push: { remoteRevision: COMMIT },
              mergeRequest: {
                iid: 17,
                url: "https://gitlab.example.test/group/docs/-/merge_requests/17",
                state: "opened",
                draft: true,
                sourceBranch: plan.proposedSourceBranch,
                targetBranch: plan.targetBranch.name,
                headRevision: COMMIT,
              },
            },
          }) as never,
        inspectCommit: async () => ({
          revision: COMMIT,
          treeRevision: TREE,
          parentRevision: SOURCE,
          parentCount: 1,
        }),
        randomId: () => "fake-live-success",
        log: (message) => output.push(message),
      },
    );

    expect({ preflightCalls, executeCalls }).toEqual({ preflightCalls: 1, executeCalls: 1 });
    const result = JSON.parse(output.at(-1) ?? "{}") as { manifestPath: string };
    const manifest = decodeDeliveryAcceptanceManifest(
      JSON.parse(await readFile(result.manifestPath, "utf8")) as unknown,
    );
    expect(manifest).toMatchObject({
      mode: "live",
      testedRevision: TESTED,
      sourceRevision: SOURCE,
      chain: { sha256: chain.sha256 },
      plan: { sha256: plan.sha256, runRecordSha256: RECORD, patchSha256: PATCH },
      commit: { revision: COMMIT, treeRevision: TREE, parentRevision: SOURCE, parentCount: 1 },
      remote: { headRevision: COMMIT },
      mergeRequest: { iid: 17, draft: true, headRevision: COMMIT },
      receipt: { sha256: receiptSha256, planSha256: plan.sha256 },
      failureMatrixSummary: { expectedCaseCount: 11, observedCaseCount: 11 },
      liveGate: { status: "approved-and-run", cleanup: "separately-gated" },
    });
  });

  it("runs a fake live read-only preflight through the same exact chain inputs", async () => {
    const root = await roots.create("docsfab-live-manifest-");
    const plan = publicationPlan();
    const chain = acceptanceChain();
    const chainPath = join(root, "chain.json");
    const matrixPath = join(root, "matrix.json");
    const chainEvidenceArgs = await privateChainEvidenceArgs(root);
    await Promise.all([
      writePrivate(chainPath, canonicalizeJsonEvidence(chain as never)),
      writePrivate(
        matrixPath,
        canonicalizeJsonEvidence(offlineMatrixManifest(chain, plan) as never),
      ),
    ]);
    const output: string[] = [];
    let executeCalled = false;
    process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE = "true";
    await runDeliveryAcceptanceCli(
      [
        "--live",
        "--preflight-only",
        "--repo",
        root,
        "--run-id",
        "write-run",
        "--state-dir",
        join(root, "state"),
        "--approve-project-id",
        "42",
        "--approve-project-path",
        "group/docs",
        "--approve-action",
        "inspect-only",
        "--tested-revision",
        TESTED,
        "--chain-manifest",
        chainPath,
        "--offline-manifest",
        matrixPath,
        ...chainEvidenceArgs,
      ],
      {
        currentDocsFabRevision: async () => TESTED,
        assembleChain: () => chain,
        sourceCheckoutSha256: async () => "a".repeat(64),
        preflight: async () => plan,
        loadRun: async () => verifiedRun(root),
        execute: async () => {
          executeCalled = true;
        },
        log: (message) => output.push(message),
      },
    );

    expect(executeCalled).toBe(false);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      kind: "docsfab-local-user-gitlab-publication-plan",
      sha256: plan.sha256,
      run: { id: "write-run", recordSha256: RECORD },
      patch: { sha256: PATCH },
    });
  });
});

function publicationPlan(): LocalUserPublicationPlanV1 {
  const content = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "write-run", recordSha256: RECORD },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "https" },
    identity: {
      git: "configured",
      gitIdentitySha256: "4".repeat(64),
      gitlabUsername: "maintainer",
    },
    baseRevision: SOURCE,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/write-run",
    patch: { format: "git-diff", sha256: PATCH, byteLength: 10, changedFileCount: 1 },
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
  return { ...content, sha256: localUserPublicationPlanSha256(content) };
}

function offlineMatrixManifest(
  chain: ReturnType<typeof finalizeDeliveryAcceptanceChainBinding>,
  plan: LocalUserPublicationPlanV1,
) {
  const failureMatrix = DELIVERY_ACCEPTANCE_CASE_IDS.map((id) => {
    const externalMutations =
      id === "duplicate-invocation" || id.startsWith("interruption-") ? 2 : 0;
    return {
      id,
      status: "passed" as const,
      expectedFailureCode: id === "duplicate-invocation" ? "reused" : "expected-failure",
      observedFailureCode: id === "duplicate-invocation" ? "reused" : "expected-failure",
      patchPreserved: true as const,
      nextAction: externalMutations === 0 ? "review-preserved-patch" : "none",
      sourceCheckoutUnchanged: true as const,
      worktreeState: "preserved" as const,
      receiptState: externalMutations === 0 ? ("absent" as const) : ("opened" as const),
      remoteBranchState: externalMutations === 0 ? ("absent" as const) : ("present" as const),
      mergeRequestState: externalMutations === 0 ? ("absent" as const) : ("opened" as const),
      expectedExternalMutationCount: externalMutations,
      observedExternalMutationCount: externalMutations,
    };
  });
  return finalizeDeliveryAcceptanceManifest({
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-delivery-acceptance",
    mode: "offline",
    status: "passed",
    testedRevision: TESTED,
    sourceRevision: SOURCE,
    chain,
    plan: {
      sha256: plan.sha256,
      baseRevision: SOURCE,
      runRecordSha256: RECORD,
      patchSha256: PATCH,
    },
    publicationAuthorization: {
      decision: "authorized",
      command: "publish",
      planSha256: plan.sha256,
    },
    validation: {
      commandSha256: "e".repeat(64),
      summarySha256: "f".repeat(64),
      status: "passed",
      checkCount: 1,
    },
    commit: {
      revision: COMMIT,
      treeRevision: TREE,
      parentRevision: SOURCE,
      parentCount: 1,
      baseRevision: SOURCE,
    },
    remote: {
      identitySha256: "6".repeat(64),
      name: "origin",
      transport: "https",
      sourceBranch: plan.proposedSourceBranch,
      targetBranch: "main",
      headRevision: COMMIT,
    },
    mergeRequest: {
      iid: 17,
      draft: true,
      state: "opened",
      sourceBranch: plan.proposedSourceBranch,
      targetBranch: "main",
      headRevision: COMMIT,
      identitySha256: "7".repeat(64),
    },
    receipt: {
      idempotencyKey: scmDeliveryIdempotencyKey(plan),
      sha256: "8".repeat(64),
      state: "opened",
      disposition: "succeeded",
      planSha256: plan.sha256,
    },
    sourceCheckout: {
      status: "unchanged",
      beforeSha256: "9".repeat(64),
      afterSha256: "9".repeat(64),
      ignored: {
        ...DELIVERY_ACCEPTANCE_EMPTY_IGNORED_STATE_SUMMARY,
        notObservedReasons: [],
      },
    },
    idempotency: { invocationCount: 2, mergeRequestCreateCount: 1, status: "reused" },
    failureMatrix,
    failureMatrixSummary: {
      expectedCaseCount: failureMatrix.length,
      observedCaseCount: failureMatrix.length,
      expectedExternalMutationCount: 8,
      observedExternalMutationCount: 8,
    },
    liveGate: { status: "not-run", cleanup: "separately-gated" },
    dogfoodDisposition: "sufficient-for-complex-local-dogfood",
  });
}

function acceptanceChain() {
  return finalizeDeliveryAcceptanceChainBinding({
    schemaVersion: 1,
    kind: "docsfab-delivery-acceptance-chain-binding",
    testedRevision: TESTED,
    sourceRevision: SOURCE,
    readiness: run("readiness-run", "4".repeat(64), "readiness", "Repository is ready", []),
    audit: run(
      "audit-run",
      "5".repeat(64),
      "review-documentation",
      "Documentation gap identified",
      [],
    ),
    write: run("write-run", RECORD, "update-documentation", OUTCOME, ["docs/guide.md"]),
    selection: {
      gapId: "gap-1",
      evidenceSha256: "6".repeat(64),
      successCriterionSha256: "7".repeat(64),
      intendedPaths: ["docs/guide.md"],
      approvedOutcomeSha256: sha256(OUTCOME),
    },
    authorization: {
      sha256: "8".repeat(64),
      digest: "9".repeat(64),
      decision: "approved",
      reviewerId: "maintainer-1",
      policyDigest: "0".repeat(64),
      decidedAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2026-08-04T01:00:00.000Z",
    },
    patch: {
      sha256: PATCH,
      byteLength: 10,
      lineCount: 1,
      changedPaths: ["docs/guide.md"],
    },
  });
}

function verifiedRun(root: string) {
  return {
    id: "write-run",
    workflow: "update-documentation" as const,
    workflowOutcome: OUTCOME,
    recordSha256: RECORD,
    sourcePath: root,
    revision: SOURCE,
    patch: {
      sha256: PATCH,
      byteLength: 10,
      lineCount: 1,
      artifactPath: join(root, "private.patch"),
      format: "git-diff" as const,
    },
    patchBytes: Buffer.from("0123456789"),
    changedFiles: [{ path: "docs/guide.md", status: "modified" as const }],
    changedFileCount: 1,
    taskLineage: null,
  };
}

function run(
  id: string,
  recordSha256: string,
  workflow: "readiness" | "review-documentation" | "update-documentation",
  outcome: string,
  changedPaths: string[],
) {
  return { id, recordSha256, workflow, status: "succeeded" as const, outcome, changedPaths };
}

async function writePrivate(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function privateChainEvidenceArgs(root: string): Promise<string[]> {
  const entries = [
    ["--readiness-record", "readiness.json"],
    ["--declaration", "declaration.json"],
    ["--analysis-record", "analysis.json"],
    ["--authorization", "authorization.json"],
    ["--reviewer-policy", "reviewer-policy.json"],
    ["--write-record", "write.json"],
    ["--patch", "application.patch"],
  ] as const;
  await Promise.all(entries.map(([, name]) => writePrivate(join(root, name), "{}")));
  return entries.flatMap(([flag, name]) => [flag, join(root, name)]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
