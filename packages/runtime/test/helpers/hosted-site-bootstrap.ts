// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared fixture chain for the hosted `site-bootstrap` suites. It signs a real
 * application bundle the way the product does (hosted IA analysis, hosted IA
 * plan, operator approval with a reviewer key) and stages one job the way the
 * host spine does, so the executor's checks face the real document.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { DurableArtifactStore } from "../../src/artifacts/index.js";
import { buildContentIndex } from "../../src/content-ir/index.js";
import { canonicalDigest as custodyDigest } from "../../src/contract-kit/index.js";
import {
  sealHostRuntimeNativeTask,
  type HostRuntimeApprovedNativeImportV1,
  type HostRuntimeResolvedNativeInputV1,
} from "../../src/host-invoker/native-task.js";
import { assembleHostedIa, type HostedIaCustody } from "../../src/ia/hosted.js";
import { provisionIaPlanningInputPackage } from "../../src/ia/input-provider.js";
import { approveIaPlanForBootstrap } from "../../src/ia/lifecycle.js";
import { iaPlanReviewerPolicyDigest } from "../../src/ia/plan-review.js";
import { prepareRepositoryWorkspace } from "../../src/repository/workspace/materialize.js";
import type { SiteBootstrapApplicationBundle } from "../../src/site-bootstrap/contracts.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import { runHostedWorkflow } from "../../src/host-invoker/workflow-runner.js";
import { inspectHostedWorkflowCatalog } from "../../src/host-invoker/workflow-catalog.js";
import {
  describeHostRuntimeNativeInput,
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeNativeCustody,
  sealHostRuntimeWriteAuthority,
  type HostRuntimeNativeCustodyV1,
  type HostRuntimeProgressV1,
} from "../../src/host-invoker/contracts.js";
import { modelSubmission } from "./ia-native-submission.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-09-22T20:00:00.000Z");
export const IA_TASK = { kind: "ia-plan", scope: "site", mode: "create" } as const;
const IDENTITY = "1".repeat(64);
const PLANNING_RUN = "hosted-planning";
const RUN_ID = "hosted-site";
/** The requesting Slack principal, deliberately not the importing operator. */
export const REQUEST_PRINCIPAL = "fixture-member";
/** The operator who imported the signed plan through the approval ledger. */
const IMPORT_PRINCIPAL = "fixture-operator";
const BINDING = {
  deploymentId: "native-test",
  projectId: "native-project",
  deploymentEpoch: "epoch-one",
};
const RECEIPT_PREFIX = `cas:${custodyDigest(BINDING).slice(0, 32)}:`;

/** Where the site arm's evidence collector persists the run's reviewable patch. */
export function nativePatchPath(staged: StagedSiteRequest): string {
  return join(staged.stateDirectory, "native-patches", `${RUN_ID}.patch`);
}

export async function removeHostedSiteFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/**
 * Drive one staged job through the shipped runner entry, with no model edge.
 * `emit` observes the runner's own progress events, in order, as they happen.
 */
export function runSite(
  staged: StagedSiteRequest,
  emit: (event: HostRuntimeProgressV1) => void = () => {},
) {
  return runHostedWorkflow({
    request: staged.request,
    credential: null,
    emit,
    executionHarness: {
      async runStep() {
        throw new Error("unexpected model call");
      },
    },
  });
}

async function privateState(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function repositoryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-hosted-site-")));
  roots.push(root);
  const repository = await privateState(root, "repository");
  for (const [name, text] of Object.entries({
    "README.md": "# Operators\n\nOperators connect and publish services.\n",
    "connect.md": "# Connect\n\nConnect a cluster endpoint before publishing.\n",
    "publish.md": "# Publish\n\nPublish a connected service.\n",
  }))
    await writeFile(join(repository, name), text);
  await execFile("git", ["init", "-q", repository]);
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", [
    "-C",
    repository,
    "-c",
    "user.name=DocsFab Test",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const revision = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  return { root, repository, revision };
}

export type ApprovedPlanFixture = Awaited<ReturnType<typeof buildApprovedPlanFixture>>;
let approvedPlanCache: Promise<ApprovedPlanFixture> | undefined;
/** One real analysis -> plan -> reviewer-signature chain, reused by every case in a file. */
export function approvedPlanFixture(): Promise<ApprovedPlanFixture> {
  return (approvedPlanCache ??= buildApprovedPlanFixture());
}

async function buildApprovedPlanFixture() {
  const fixture = await repositoryFixture();
  const recordsRoot = await privateState(fixture.root, "custody");
  const artifactStore = new DurableArtifactStore(join(recordsRoot, "artifacts"));
  let selected: HostRuntimeResolvedNativeInputV1 | undefined;
  const custody: HostedIaCustody = {
    repositoryIdentitySha256: IDENTITY,
    artifactStore,
    async loadSelected() {
      if (!selected) throw new Error("no selected analysis");
      return selected;
    },
    async retain(record) {
      await writeFile(join(recordsRoot, `${record.recordKind}.json`), record.bytes, {
        mode: 0o600,
      });
    },
  };
  const analysisWorkspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
  const analysisState = await privateState(fixture.root, "analysis-state");
  const analysis = await assembleHostedIa({
    nativeTask: sealHostRuntimeNativeTask({
      workflow: "ia-analysis",
      task: IA_TASK,
      inputs: [],
    }),
    workspace: analysisWorkspace,
    stateDirectory: analysisState,
    projectRoot: PROJECT_ROOT,
    custody,
    now: () => NOW,
  });
  const index = await buildContentIndex({
    repositoryPath: analysisWorkspace.path,
    repositoryRevision: fixture.revision,
  });
  const analysisWorkflow = getWorkflow("ia-analysis");
  const analyzed = await analysis.wrapHarness!({
    async runStep() {
      return { summary: JSON.stringify(modelSubmission(index)), outcome: "succeeded" };
    },
  }).runStep({
    repositoryPath: analysisWorkspace.path,
    workflow: analysisWorkflow,
    step: analysisWorkflow.steps[0]!,
    task: IA_TASK,
    runId: "hosted-analysis",
  });
  expect(analyzed.outcome).toBe("succeeded");
  await analysisWorkspace.dispose();

  const analysisBytes = await readFile(join(recordsRoot, "docsfab-ia-analysis-output.json"));
  const analysisSha256 = createHash("sha256").update(analysisBytes).digest("hex");
  const analysisReference = {
    receiptLocator: `cas:${"a".repeat(32)}:${"b".repeat(64)}`,
    artifactSha256: analysisSha256,
  };
  selected = {
    recordKey: "8".repeat(64),
    bytes: analysisBytes,
    contentSha256: analysisSha256,
    source: {
      requestKey: "analysis-request",
      runId: "hosted-analysis",
      principalId: REQUEST_PRINCIPAL,
      workflow: "ia-analysis",
      revision: fixture.revision,
      repositoryIdentitySha256: IDENTITY,
      receiptLocator: analysisReference.receiptLocator,
      receiptSha256: "b".repeat(64),
    },
  };
  const planningWorkspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
  const planningState = await privateState(fixture.root, "planning-state");
  const planned = await assembleHostedIa({
    nativeTask: sealHostRuntimeNativeTask({
      workflow: "ia-plan",
      task: IA_TASK,
      inputs: [analysisReference],
    }),
    workspace: planningWorkspace,
    stateDirectory: planningState,
    projectRoot: PROJECT_ROOT,
    custody,
    now: () => NOW,
  });
  const planWorkflow = getWorkflow("ia-plan");
  const planResult = await planned.hostOperations!.runStep({
    repositoryPath: planningWorkspace.path,
    workflow: planWorkflow,
    step: planWorkflow.steps[0]!,
    task: IA_TASK,
    runId: PLANNING_RUN,
  });
  expect(planResult.outcome).toBe("succeeded");
  await planningWorkspace.dispose();
  const pendingPlanReference = planResult.artifacts.find(
    (artifact) => artifact.role === "output" && artifact.reference.kind === "ia-plan",
  )!.reference;
  // The producer's exact pending plan, as the ia-plan job retained it: the
  // import binds a signed successor to these bytes, never to a restatement.
  const pendingPlan = await artifactStore.getRecord(pendingPlanReference.digest);

  // Hydrate the retained planning package through the canonical provisioner, as
  // the operator command expects to find it.
  const planningRecord = JSON.parse(
    await readFile(join(recordsRoot, "docsfab-ia-planning-input.json"), "utf8"),
  ) as { package: { input: unknown; expiresAt: string } };
  await provisionIaPlanningInputPackage({
    packageRoot: join(recordsRoot, "ia-inputs", IDENTITY),
    repositoryPath: fixture.repository,
    repositoryIdentity: IDENTITY,
    task: IA_TASK,
    index: await buildContentIndex({
      repositoryPath: fixture.repository,
      repositoryRevision: fixture.revision,
    }),
    input: planningRecord.package.input as never,
    expiresAt: planningRecord.package.expiresAt,
    now: NOW,
  });
  await mkdir(join(recordsRoot, "runs"), { mode: 0o700 });
  await writeFile(
    join(recordsRoot, "runs", `${PLANNING_RUN}.json`),
    JSON.stringify({
      id: PLANNING_RUN,
      workflow: "ia-plan",
      repository: { revision: fixture.revision },
      artifacts: planResult.artifacts,
    }),
    { mode: 0o600 },
  );

  // A real reviewer key and policy. Test-only keys never enter task data.
  const keys = generateKeyPairSync("ed25519");
  const policyValue = {
    id: "docsfab:fixture-reviewers",
    version: "1",
    reviewers: [
      {
        id: "maintainer:fixture",
        role: "maintainer" as const,
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  };
  const reviewerPolicy = { ...policyValue, digest: iaPlanReviewerPolicyDigest(policyValue) };
  const policyPath = join(fixture.root, "reviewer-policy.json");
  const keyPath = join(fixture.root, "reviewer-key.pem");
  await writeFile(policyPath, JSON.stringify(reviewerPolicy), { mode: 0o600 });
  await writeFile(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const handoff = await approveIaPlanForBootstrap({
    stateRoot: recordsRoot,
    repositoryPath: fixture.repository,
    repositoryRevision: fixture.revision,
    repositoryIdentity: IDENTITY,
    task: IA_TASK,
    planningRunId: PLANNING_RUN,
    reviewerPolicyPath: policyPath,
    reviewerId: "maintainer:fixture",
    privateKeyPath: keyPath,
    now: NOW,
  });
  const bundleBytes = await readFile(handoff.applicationPath);
  const bundle = JSON.parse(bundleBytes.toString("utf8")) as SiteBootstrapApplicationBundle;
  const policyBytes = Buffer.from(JSON.stringify(reviewerPolicy));
  return {
    ...fixture,
    /** The operator-side file the approval command wrote the signed bundle to. */
    applicationPath: handoff.applicationPath,
    bundle,
    bundleBytes,
    reviewerPolicy,
    policyBytes,
    pendingPlan,
    now: NOW,
  };
}

/** A pristine checkout of the same commit, so one case's writes cannot leak. */
async function cloneCheckout(approved: ApprovedPlanFixture, name: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `docsfab-site-${name}-`)));
  roots.push(root);
  const checkout = join(root, "checkout");
  await execFile("git", ["clone", "--no-hardlinks", "-q", approved.repository, checkout]);
  await chmod(checkout, 0o700);
  return checkout;
}

export interface StagedSiteRequestOptions {
  name?: string;
  bundleBytes?: Buffer;
  policyBytes?: Buffer;
  approvedImport?: Partial<HostRuntimeApprovedNativeImportV1> | null;
  sourceOverrides?: Partial<HostRuntimeResolvedNativeInputV1["source"]>;
  pathCeiling?: string[];
  taskWorkflow?: "site-bootstrap" | "ia-plan";
  extraInput?: boolean;
  withoutNativeTask?: boolean;
  advanceCheckout?: boolean;
  taskPlanOverrides?: Record<string, unknown>;
}

export type StagedSiteRequest = Awaited<ReturnType<typeof stagedRequest>>;

/**
 * Stage one job the way the host spine does: bundle bytes and reviewer-policy
 * bytes as private `native-inputs/<sha>.json` files, a custody row carrying the
 * registered `approvedImport`, and a sealed grant whose ceiling covers exactly
 * the plan's approved outputs.
 */
export async function stagedRequest(
  approved: ApprovedPlanFixture,
  options: StagedSiteRequestOptions,
) {
  const name = options.name ?? "journey";
  const checkout = await cloneCheckout(approved, name);
  if (options.advanceCheckout) {
    await writeFile(join(checkout, "LATER.md"), "# Later\n\nA commit after approval.\n");
    await execFile("git", ["-C", checkout, "add", "LATER.md"]);
    await execFile("git", [
      "-C",
      checkout,
      "-c",
      "user.name=DocsFab Test",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "later",
    ]);
  }
  const revision = (await execFile("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
  const root = resolve(checkout, "..");
  const stateDirectory = await privateState(root, "site-state");
  const bundleBytes = options.bundleBytes ?? approved.bundleBytes;
  const policyBytes = options.policyBytes ?? approved.policyBytes;
  const bundleSha256 = await stageNativeInput(stateDirectory, bundleBytes);
  const policySha256 = await stageNativeInput(stateDirectory, policyBytes);
  const approvedImport: HostRuntimeApprovedNativeImportV1 | undefined =
    options.approvedImport === null
      ? undefined
      : {
          kind: "site-bootstrap-approval",
          receiptLocator: RECEIPT_PREFIX + "c".repeat(64),
          receiptSha256: "c".repeat(64),
          authorityReceiptSha256: "d".repeat(64),
          reviewerPolicySha256: approved.reviewerPolicy.digest,
          reviewerPolicyContentSha256: policySha256,
          reviewerPolicyBytes: policyBytes.byteLength,
          ...(options.approvedImport ?? {}),
        };
  const producerReceiptSha256 = "e".repeat(64);
  const resolved: HostRuntimeResolvedNativeInputV1 = {
    recordKey: createHash("sha256").update(`record:${bundleSha256}`).digest("hex"),
    contentSha256: bundleSha256,
    bytes: bundleBytes,
    ...(approvedImport ? { approvedImport } : {}),
    source: {
      requestKey: "import-request",
      runId: PLANNING_RUN,
      // The importing operator, not the requesting principal: the site arm's
      // actor-binding relaxation admits this row.
      principalId: IMPORT_PRINCIPAL,
      workflow: "ia-plan",
      revision,
      repositoryIdentitySha256: IDENTITY,
      receiptLocator: RECEIPT_PREFIX + producerReceiptSha256,
      receiptSha256: producerReceiptSha256,
      ...(options.sourceOverrides ?? {}),
    },
  };
  const selectionLocator = approvedImport?.receiptLocator ?? resolved.source.receiptLocator;
  const workflow = options.taskWorkflow ?? "site-bootstrap";
  const siteTask = {
    kind: "site-bootstrap",
    plan: {
      kind: "ia-plan",
      schemaVersion: approved.bundle.plan.schemaVersion,
      digest: approved.bundle.plan.digest,
      repositoryRevision: approved.bundle.plan.repository.revision,
      repositoryContentDigest: approved.bundle.plan.repository.contentDigest,
      ...(options.taskPlanOverrides ?? {}),
    },
  };
  const extra = options.extraInput
    ? await stagedExtraInput(stateDirectory, revision, RECEIPT_PREFIX)
    : undefined;
  const task =
    workflow === "site-bootstrap"
      ? sealHostRuntimeNativeTask({
          workflow: "site-bootstrap",
          task: siteTask,
          inputs: [
            { receiptLocator: selectionLocator, artifactSha256: bundleSha256 },
            ...(extra ? [extra.reference] : []),
          ],
        })
      : sealHostRuntimeNativeTask({
          workflow: "ia-plan",
          task: IA_TASK,
          inputs: [{ receiptLocator: selectionLocator, artifactSha256: bundleSha256 }],
        });
  const custodyInputs: HostRuntimeNativeCustodyV1["inputs"] = [
    describeHostRuntimeNativeInput(resolved),
    ...(extra ? [extra.custodyInput] : []),
  ];
  const catalog = inspectHostedWorkflowCatalog(workflow);
  const capsule = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [
      { evidenceId: "approved-model", content: "Operators connect and publish services." },
    ],
  };
  const capsuleSha256 = digest(capsule);
  const content = "{}";
  const sourceTreeObjectId = (
    await execFile("git", ["-C", checkout, "rev-parse", "HEAD^{tree}"])
  ).stdout.trim();
  const composition = sealHostRuntimeComposition({
    compositionId: "native-test",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools: catalog.declaredTools,
  });
  const toolPolicySha256 = digest({
    workflow: catalog.workflow,
    stepIds: catalog.stepIds,
    declaredTools: catalog.declaredTools,
  });
  const pathCeiling =
    options.pathCeiling ?? approved.bundle.plan.payload.outputScope.map((output) => output.path);
  const request = parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    ...BINDING,
    requestKey: "hosted-site-request",
    origin: { principalId: REQUEST_PRINCIPAL, requestId: "message-one" },
    runId: RUN_ID,
    fence: 1,
    workflow,
    revision,
    sourceTreeObjectId,
    packet: {
      packetFingerprintSha256: "b".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: createHash("sha256").update(content).digest("hex"),
        sourcePathSha256: "c".repeat(64),
        gitObjectId: "d".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
      ...(options.withoutNativeTask ? {} : { nativeTask: task }),
    },
    ...(options.withoutNativeTask
      ? {}
      : {
          nativeCustody: sealHostRuntimeNativeCustody({
            task,
            binding: BINDING,
            repositoryIdentitySha256: IDENTITY,
            approvedCanonSha256: "e".repeat(64),
            inputs: custodyInputs,
          }),
        }),
    stepIds: catalog.stepIds,
    composition,
    toolPolicySha256,
    workspacePath: checkout,
    stateDirectory,
    capsule: { ...capsule, sha256: capsuleSha256 },
    allowWrite: workflow === "site-bootstrap",
    ...(workflow === "site-bootstrap"
      ? {
          writeAuthority: sealHostRuntimeWriteAuthority({
            schemaVersion: 2,
            kind: "docsfab-host-runtime-write-authority",
            ...BINDING,
            requestKey: "hosted-site-request",
            runId: RUN_ID,
            fence: 1,
            workflow: "site-bootstrap",
            sourceRevision: revision,
            sourceTreeObjectId,
            pathCeiling,
            targets: [],
            writeStepIds: catalog.writeStepIds,
            capsuleSha256,
            compositionSha256: composition.compositionSha256,
            toolPolicySha256,
            expiresAt: "2098-01-01T00:00:00.000Z",
            limits: { maximumChangedPaths: 64, maximumPatchBytes: 1024 * 1024 },
          }),
        }
      : {}),
  });
  return {
    request,
    checkout,
    stateDirectory,
    revision,
    bundleSha256,
    policySha256,
    selectionLocator,
  };
}

/** A second accepted producer output, so the arm sees two selected inputs. */
async function stagedExtraInput(stateDirectory: string, revision: string, receiptPrefix: string) {
  const bytes = Buffer.from(JSON.stringify({ kind: "docsfab-unrelated", note: "second" }));
  const contentSha256 = await stageNativeInput(stateDirectory, bytes);
  const receiptSha256 = "f".repeat(64);
  const resolved: HostRuntimeResolvedNativeInputV1 = {
    recordKey: createHash("sha256").update(`record:${contentSha256}`).digest("hex"),
    contentSha256,
    bytes,
    source: {
      requestKey: "import-request",
      runId: PLANNING_RUN,
      principalId: REQUEST_PRINCIPAL,
      workflow: "ia-plan",
      revision,
      repositoryIdentitySha256: IDENTITY,
      receiptLocator: receiptPrefix + receiptSha256,
      receiptSha256,
    },
  };
  return {
    reference: { receiptLocator: resolved.source.receiptLocator, artifactSha256: contentSha256 },
    custodyInput: describeHostRuntimeNativeInput(resolved),
  };
}

async function stageNativeInput(stateDirectory: string, bytes: Buffer): Promise<string> {
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = join(stateDirectory, "native-inputs");
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const path = join(directory, `${contentSha256}.json`);
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
  return contentSha256;
}

/**
 * Every retained `docsfab-site-bootstrap-run` record under a job's private
 * artifact store, with the byte count the store wrote. A job refused before the
 * arm built its store reports no records.
 */
export async function retainedSiteRunRecords(stateDirectory: string) {
  const records: {
    bytes: number;
    kind: string;
    record: { status: string; mutationBoundaryEntered: boolean };
  }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      const contents = await readFile(next);
      const parsed = JSON.parse(contents.toString("utf8"));
      if (parsed?.kind === "docsfab-site-bootstrap-run")
        records.push({ bytes: contents.byteLength, ...parsed });
    }
  };
  const root = join(stateDirectory, "artifacts");
  if (!existsSync(root)) return records;
  await walk(root);
  return records;
}
