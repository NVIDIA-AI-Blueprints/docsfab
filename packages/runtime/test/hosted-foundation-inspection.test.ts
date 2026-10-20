// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { sealHostRuntimeNativeTask } from "../src/host-invoker/native-task.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { assembleHostedNativeOperations } from "../src/host-invoker/native-operations.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { inspectHostedWorkflowCatalog } from "../src/host-invoker/workflow-catalog.js";
import {
  digest,
  parseHostRuntimeRequest,
  parseHostRuntimeTerminal,
  sealHostRuntimeComposition,
  sealHostRuntimeNativeCustody,
  sealHostRuntimeTerminal,
} from "../src/host-invoker/contracts.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const IDENTITY = "1".repeat(64);
const RUN_ID = "hosted-foundation";
/**
 * A catalogued native workflow whose installed step is a `write` step. Its plan
 * reference is inert: the runner's grant gate refuses this ungranted request
 * before anything reads it.
 */
const SITE_TASK = {
  kind: "site-bootstrap",
  plan: {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: "9".repeat(64),
    repositoryRevision: "f".repeat(40),
    repositoryContentDigest: "7".repeat(64),
  },
} as const;
const LOCAL_SUITE_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hosted Foundation inspection", { timeout: testTimeoutMs(LOCAL_SUITE_TIMEOUT_MS) }, () => {
  it("runs hosted Foundation inspection without model calls and retains actionable missing-input questions", async () => {
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "actual-hosted-foundation");
    const request = await requestForNative(fixture, "foundation", stateDirectory);
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit() {},
      executionHarness: {
        async runStep() {
          throw new Error("unexpected model call");
        },
      },
    });
    expect(result.record.status, result.record.error).toBe("needs-input");
    expect(result.record.steps[0]?.skillEvidence?.id).toBe("doc-context-analyzer");
    expect(result.patch).toBeNull();
    const objects = join(stateDirectory, "artifacts", "objects", "sha256");
    const values = await Promise.all(
      (await readdir(objects)).map(async (name) =>
        JSON.parse(await readFile(join(objects, name), "utf8")),
      ),
    );
    const questions = values.find(
      (value) => value.kind === "docsfab-foundation-onboarding-questions",
    );
    expect(questions?.questions.length).toBeGreaterThan(0);
    expect(
      (await execFile("git", ["-C", fixture.repository, "status", "--porcelain"])).stdout,
    ).toBe("");
  });

  it("binds the typed task and its custody into the sealed terminal record", async () => {
    // The host re-verifies the terminal binding. Task and custody are optional
    // on the wire, so the round trip through `parseHostRuntimeTerminal` proves
    // they survive re-parsing.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "terminal-binding");
    const request = await requestForNative(fixture, "foundation", stateDirectory);
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit() {},
      executionHarness: {
        async runStep() {
          throw new Error("unexpected model call");
        },
      },
    });
    const terminal = sealHostRuntimeTerminal({
      request,
      status: "needs-input",
      runtimeRecord: result.record,
      patch: null,
    });
    expect(terminal.runRecord.binding.nativeTaskSha256).toBe(request.packet.nativeTask?.taskSha256);
    expect(terminal.runRecord.binding.nativeCustodySha256).toBe(
      request.nativeCustody?.custodySha256,
    );
    const reparsed = parseHostRuntimeTerminal(JSON.parse(JSON.stringify(terminal)), request);
    expect(reparsed.runRecord.binding.nativeTaskSha256).toBe(request.packet.nativeTask?.taskSha256);
    expect(reparsed.runRecord.binding.nativeCustodySha256).toBe(
      request.nativeCustody?.custodySha256,
    );
    // Foundation inspection is a host-operation job whose harness refuses
    // inference, so a successful run records zero models and the terminal
    // policy must admit that rather than re-seal it as a failure.
    expect(result.record.models).toEqual([]);
    expect(
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: { ...result.record, status: "succeeded" },
        patch: null,
      }).status,
    ).toBe("succeeded");
    // Dropping either key from a valid sealed terminal breaks the match with
    // the request's projected binding.
    for (const key of ["nativeTaskSha256", "nativeCustodySha256"] as const) {
      const stripped = JSON.parse(JSON.stringify(terminal));
      delete stripped.runRecord.binding[key];
      expect(() => parseHostRuntimeTerminal(stripped, request)).toThrow(
        "terminal-binding-mismatch",
      );
    }
  });

  it("refuses a hosted write workflow with no separate grant before it assembles anything", async () => {
    // `site-bootstrap`'s installed step is a write step, so `runHostedWorkflow`
    // refuses a request carrying no grant before any workspace is prepared or
    // any arm is assembled.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "ungranted-native-write");
    const request = await requestForNative(fixture, "site-bootstrap", stateDirectory);
    await expect(
      runHostedWorkflow({
        request,
        credential: null,
        emit() {},
        executionHarness: {
          async runStep() {
            throw new Error("unexpected model call");
          },
        },
      }),
    ).rejects.toThrow("Hosted write workflows require a separate operation-specific write grant.");
    // A hosted native name whose installed step is read-only assembles from the
    // same request shape with no grant.
    const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
    try {
      const installed = await requestForNative(
        fixture,
        "foundation",
        await privateState(fixture.root, "installed-native-executor"),
      );
      const assembled = await assembleHostedNativeOperations({
        request: installed,
        workspace,
        workflow: getWorkflow("foundation"),
      });
      expect(assembled.harness).toBeDefined();
    } finally {
      await workspace.dispose();
    }
  });

  it("refuses a preflight-only native composition route before it prepares a workspace", async () => {
    // The route check is outside `createHarness`, which a native operation does
    // not call.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "native-route-refusal");
    const request = await requestForNative(fixture, "foundation", stateDirectory, "native-codex");
    await expect(runHostedWorkflow({ request, credential: null, emit() {} })).rejects.toMatchObject(
      {
        name: "UnsupportedNativeCompositionError",
        message:
          "host-invoker: native-codex is preflight-only until a contained runner is installed",
      },
    );
  });
  it("refuses a transported canon whose Git object digest differs from its bytes", async () => {
    // The bound canon's bytes must reproduce both the content digest the
    // custody names and the Git blob id the packet claims. A model snapshot can
    // be older than the inspected revision, so the transported blob is verified
    // rather than read from the current tree.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "canon-object-mismatch");
    const content = JSON.stringify({ kind: "knowledge-accepted-snapshot" });
    const request = await requestForNative(
      fixture,
      "foundation",
      stateDirectory,
      "offline-fixture",
      {
        content,
        // Well-formed and accepted by the packet codec, but not this content's blob.
        gitObjectId: "a".repeat(40),
      },
    );
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit() {},
      executionHarness: {
        async runStep() {
          throw new Error("unexpected model call");
        },
      },
    });
    expect(result.record.status).toBe("failed");
    expect(JSON.stringify(result.record)).toContain(
      "Hosted Foundation refused the frozen canon because its content or Git object digest differs.",
    );
  });

  it("admits a verified canon it cannot decode and a canon custody never approved", async () => {
    // Both are fail-open reads of the canon rather than refusals: verified
    // approved bytes that do not decode as a snapshot, and a canon custody
    // never approved.
    const fixture = await repositoryFixture();
    const verified = "not a snapshot at all";
    for (const [name, canon] of [
      ["undecodable-approved-canon", { content: verified, gitObjectId: gitBlobId(verified) }],
      [
        "unapproved-canon",
        {
          content: verified,
          gitObjectId: gitBlobId(verified),
          approvedCanonSha256: "e".repeat(64),
        },
      ],
    ] as const) {
      const stateDirectory = await privateState(fixture.root, name);
      const request = await requestForNative(
        fixture,
        "foundation",
        stateDirectory,
        "offline-fixture",
        canon,
      );
      const result = await runHostedWorkflow({
        request,
        credential: null,
        emit() {},
        executionHarness: {
          async runStep() {
            throw new Error("unexpected model call");
          },
        },
      });
      expect(result.record.status, `${name}: ${result.record.error}`).toBe("needs-input");
      expect(result.record.steps[0]?.skillEvidence?.id).toBe("doc-context-analyzer");
    }
  });

  it("refuses a Foundation request that carries no bound native task or custody", async () => {
    // The request contract accepts a `foundation` request with neither a
    // native task nor custody (the pair rule refuses only one without the
    // other), so the guard in `foundation/hosted.ts` refuses an unbound
    // inspection.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "native-less-foundation");
    const request = await requestForNative(
      fixture,
      "foundation",
      stateDirectory,
      "offline-fixture",
    );
    const { nativeTask: _task, ...packet } = request.packet;
    const { nativeCustody: _custody, ...rest } = request;
    const unbound = parseHostRuntimeRequest({ ...rest, packet });
    expect(unbound.packet.nativeTask).toBeUndefined();
    expect(unbound.nativeCustody).toBeUndefined();
    await expect(
      runHostedWorkflow({
        request: unbound,
        credential: null,
        emit() {},
        executionHarness: {
          async runStep() {
            throw new Error("unexpected model call");
          },
        },
      }),
    ).rejects.toThrow(
      "Hosted Foundation requires the bound read-only task and its exact repository revision.",
    );
  });

  it("admits a transported canon named by a SHA-256 Git object id", async () => {
    // A SHA-256 object-format repository names the blob with a 64-hex id, which
    // the verifier must hash with SHA-256 rather than SHA-1.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "sha256-object-id");
    const content = JSON.stringify({ kind: "not-a-snapshot" });
    const gitObjectId = gitBlobId(content, "sha256");
    expect(gitObjectId).toHaveLength(64);
    const request = await requestForNative(
      fixture,
      "foundation",
      stateDirectory,
      "offline-fixture",
      { content, gitObjectId },
    );
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit() {},
      executionHarness: {
        async runStep() {
          throw new Error("unexpected model call");
        },
      },
    });
    // Admitted, then read as an undecodable snapshot: the run pauses for input
    // instead of refusing the canon.
    expect(result.record.status, result.record.error).toBe("needs-input");
    expect(JSON.stringify(result.record)).not.toContain(
      "Hosted Foundation refused the frozen canon",
    );
    // A well-formed 64-hex id that is not this content's blob is refused.
    const mismatched = await requestForNative(
      fixture,
      "foundation",
      await privateState(fixture.root, "sha256-object-id-mismatch"),
      "offline-fixture",
      { content, gitObjectId: "a".repeat(64) },
    );
    const refused = await runHostedWorkflow({
      request: mismatched,
      credential: null,
      emit() {},
      executionHarness: {
        async runStep() {
          throw new Error("unexpected model call");
        },
      },
    });
    expect(refused.record.status).toBe("failed");
    expect(JSON.stringify(refused.record)).toContain(
      "Hosted Foundation refused the frozen canon because its content or Git object digest differs.",
    );
  });

  it("wires the checks adapter for the declared lint step and for nothing else", async () => {
    // The non-native fall-through installs the checks adapter only for the
    // declared `lint-documentation` step. For `readiness`, `hostOperations`
    // stays unset, which keeps other host-operation steps failing closed.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "ordinary-host-operations");
    const request = await ordinaryRequest(fixture, stateDirectory);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
    try {
      const withLint = await assembleHostedNativeOperations({
        request,
        workspace,
        workflow: getWorkflow("review-documentation"),
      });
      expect(withLint.hostOperations).toBeDefined();
      const withoutLint = await assembleHostedNativeOperations({
        request,
        workspace,
        workflow: getWorkflow("readiness"),
      });
      expect(withoutLint.hostOperations).toBeUndefined();
      expect(withoutLint).toEqual({});
    } finally {
      await workspace.dispose();
    }
  });
});

async function privateState(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  return path;
}

async function repositoryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-hosted-foundation-")));
  roots.push(root);
  const repository = await privateState(root, "repository");
  await chmod(repository, 0o700);
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

/** How Git names a blob, so the transported snapshot can be verified. */
function gitBlobId(content: string, algorithm: "sha1" | "sha256" = "sha1"): string {
  const bytes = Buffer.from(content);
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

interface CanonFixture {
  readonly content: string;
  readonly gitObjectId: string;
  /** Defaults to the content digest, which is what binds the canon to custody. */
  readonly approvedCanonSha256?: string;
}

async function requestForNative(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  workflow: "foundation" | "site-bootstrap",
  stateDirectory: string,
  route: "offline-fixture" | "native-codex" = "offline-fixture",
  canon?: CanonFixture,
) {
  const binding = {
    deploymentId: "native-test",
    projectId: "native-project",
    deploymentEpoch: "epoch-one",
  };
  const task =
    workflow === "foundation"
      ? sealHostRuntimeNativeTask({ workflow, task: { kind: "foundation" }, inputs: [] })
      : sealHostRuntimeNativeTask({ workflow, task: SITE_TASK, inputs: [] });
  const catalog = inspectHostedWorkflowCatalog(workflow);
  const capsule = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [
      { evidenceId: "approved-model", content: "Operators connect and publish services." },
    ],
  };
  const content = "{}",
    contentSha256 = createHash("sha256").update(content).digest("hex");
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    ...binding,
    requestKey: "hosted-foundation-request",
    origin: { principalId: "fixture-member", requestId: "message-one" },
    runId: RUN_ID,
    fence: 1,
    workflow,
    revision: fixture.revision,
    sourceTreeObjectId: (
      await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD^{tree}"])
    ).stdout.trim(),
    packet: {
      packetFingerprintSha256: "b".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: contentSha256,
        sourcePathSha256: "c".repeat(64),
        gitObjectId: "d".repeat(40),
        content,
      },
      canon: canon
        ? {
            kind: "canon",
            sha256: createHash("sha256").update(canon.content).digest("hex"),
            sourcePathSha256: "c".repeat(64),
            gitObjectId: canon.gitObjectId,
            content: canon.content,
          }
        : null,
      reviewEvent: null,
      nativeTask: task,
    },
    nativeCustody: sealHostRuntimeNativeCustody({
      task,
      binding,
      repositoryIdentitySha256: IDENTITY,
      approvedCanonSha256:
        canon?.approvedCanonSha256 ??
        (canon ? createHash("sha256").update(canon.content).digest("hex") : "e".repeat(64)),
      inputs: [],
    }),
    stepIds: catalog.stepIds,
    composition: sealHostRuntimeComposition({
      compositionId: "native-test",
      route,
      credentialFamily: "none",
      executionProfile: null,
      declaredTools: catalog.declaredTools,
    }),
    toolPolicySha256: digest({
      workflow: catalog.workflow,
      stepIds: catalog.stepIds,
      declaredTools: catalog.declaredTools,
    }),
    workspacePath: fixture.repository,
    stateDirectory,
    capsule: { ...capsule, sha256: digest(capsule) },
    allowWrite: false,
  });
}

async function ordinaryRequest(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  stateDirectory: string,
) {
  const catalog = inspectHostedWorkflowCatalog("review-documentation");
  const capsule = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [],
  };
  const content = "{}",
    contentSha256 = createHash("sha256").update(content).digest("hex");
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "native-test",
    projectId: "native-project",
    deploymentEpoch: "epoch-one",
    requestKey: "ordinary-request",
    origin: { principalId: "fixture-member", requestId: "message-two" },
    runId: "ordinary-run",
    fence: 1,
    workflow: "review-documentation",
    revision: fixture.revision,
    sourceTreeObjectId: (
      await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD^{tree}"])
    ).stdout.trim(),
    packet: {
      packetFingerprintSha256: "b".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: contentSha256,
        sourcePathSha256: "c".repeat(64),
        gitObjectId: "d".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
    },
    stepIds: catalog.stepIds,
    composition: sealHostRuntimeComposition({
      compositionId: "native-test",
      route: "offline-fixture",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools: catalog.declaredTools,
    }),
    toolPolicySha256: digest({
      workflow: catalog.workflow,
      stepIds: catalog.stepIds,
      declaredTools: catalog.declaredTools,
    }),
    workspacePath: fixture.repository,
    stateDirectory,
    capsule: { ...capsule, sha256: digest(capsule) },
    allowWrite: false,
  });
}
