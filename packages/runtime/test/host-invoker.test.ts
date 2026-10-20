// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { read, fstatSync, openSync, closeSync, type Stats } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HostRuntimeContractError,
  assertHostRuntimeWriteAuthorityBinding,
  canonicalJson,
  digest,
  parseHostRuntimeRequest,
  parseHostRuntimeProgress,
  parseHostRuntimeTerminal,
  parseHostRuntimeTerminalWire,
  sealHostRuntimeComposition,
  sealHostRuntimePatchEvidence,
  sealHostRuntimeReaderEvidencePolicy,
  sealHostRuntimeReaderTask,
  sealHostRuntimeTerminal,
  sealHostRuntimeWriteAuthority,
  type HostRuntimeRequestV1,
  type HostRuntimeWriteAuthorityV2,
} from "../src/host-invoker/contracts.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { conservativeReaderContextInput } from "../src/execution/task-context.js";
import { hostedRequestMaximumBytes } from "../src/live-agent/input-capacity.js";
import { HOST_RUNTIME_READER_REQUEST_MAXIMUM_BYTES } from "../src/host-invoker/reader-task-capacity.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import {
  buildHostRuntimeFailureRecord,
  HOSTED_RUNTIME_FAILURE_CODE_CLASSES,
  hostInvokerMain,
  readHostRuntimeRequest,
  type HostRuntimeFailurePhase,
} from "../src/host-invoker/main.js";
import { FAILURE_CLASSES } from "../src/operator/failure-class.js";
import { WorkflowRunnerBoundaryError } from "../src/workflow-execution/runner.js";
import { canonicalSourceObligationProposal } from "../src/workflow-execution/source-obligation.js";
import { LiveAgentTurnError } from "../src/host-invoker/live-agent-turn.js";
import { recomputeHostedPatchEvidence } from "../src/host-invoker/patch-evidence.js";
import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plainConfiguredCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";
import { RepositoryConfigurationRefusalError } from "../src/repository/workspace/configuration-refusal.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { unassessedSourceReadinessFixture } from "../src/readiness/assessment.js";
import {
  createReadinessFixture,
  readinessModelEdge,
  readinessRequest,
} from "./helpers/readiness-fixture.js";
import * as hostedWorkflow from "../src/host-invoker/workflow-runner.js";
import type { RunRecord } from "../src/records/contracts.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import * as workspaceMaterialize from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { sourceObligationProposalFixture, verificationFixture } from "./helpers/verification.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    read: vi.fn(actual.read),
    fstatSync: vi.fn(actual.fstatSync),
  };
});

const exec = promisify(execFile);
const roots: string[] = [];

// These journeys build a real Git repository and run the hosted adapter, which
// compiles a real structural context packet before its first step; that does
// not fit the 5 s local default.
vi.setConfig({ testTimeout: 120_000 });
const tools = [
  "canon_affected_docs",
  "canon_conflict_gap",
  "canon_propose_claim",
  "canon_query",
  "canon_submit_artifact",
  "canon_validate_citations",
  "find",
  "grep",
  "ls",
  "read",
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host runtime invoker", () => {
  it("keeps the host-owned offline readiness fixture read-only and inconclusive", async () => {
    const fixture = await createReadinessFixture();
    roots.push(fixture.root);
    const before = await fixture.git("rev-parse", "HEAD^{tree}");
    const result = await runHostedWorkflow({
      request: readinessRequest(fixture, "readiness"),
      credential: null,
      emit: () => undefined,
    });
    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    expect(result.record.workflowOutcome?.disposition).toMatch(/^(inconclusive|not-ready)$/u);
    expect(result.record.workflowOutcome?.findings.map((finding) => finding.code)).toContain(
      "readiness-source-completeness-model-assessed-unassessed",
    );
    expect(result.patch).toBeNull();
    expect(result.record.repository.revision).toBe(fixture.revision);
    expect(await fixture.git("rev-parse", "HEAD^{tree}")).toBe(before);
    expect(await fixture.git("status", "--porcelain")).toBe("");
  });

  it("does not trust an injected offline-routed harness or its provider metadata", async () => {
    const fixture = await createReadinessFixture();
    roots.push(fixture.root);
    const base = readinessModelEdge([]);
    const result = await runHostedWorkflow({
      request: readinessRequest(fixture, "readiness"),
      credential: null,
      emit: () => undefined,
      environment: { DOCSFAB_READ_ONLY_MAX_RETRIES: "0" },
      executionHarness: {
        ...base,
        async runStep(input) {
          const response = await base.runStep(input);
          return {
            ...response,
            summary: unassessedSourceReadinessFixture(input),
            model: { provider: "offline-fixture", model: "spoofed-provider" },
          };
        },
      },
    });
    expect(result.record.status).toBe("failed");
    expect(result.record.steps[0]?.inference?.attempts[0]?.outcome).toBe("malformed-response");
    expect(result.patch).toBeNull();
  });
  it("keeps imported invoker modules inert for absent, unrelated and missing entry paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-invoker-import-"));
    roots.push(root);
    const unrelated = join(root, "unrelated.mjs");
    await writeFile(unrelated, "// not the invoker\n");
    const moduleUrl = new URL("../src/host-invoker/main.ts", import.meta.url).href;
    for (const argv of [undefined, unrelated, join(root, "missing.ts")]) {
      const { stdout } = await exec(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `process.argv[1] = ${JSON.stringify(argv)}; await import(${JSON.stringify(moduleUrl)}); console.log("imported");`,
      ]);
      expect(stdout.trim()).toBe("imported");
    }
  });

  it("waits for a borrowed file's in-flight native read before reporting cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-borrowed-read-"));
    roots.push(root);
    const path = join(root, "request.json");
    await writeFile(path, "{}");
    const handle = await open(path, "r");
    const native = await vi.importActual<typeof import("node:fs")>("node:fs");
    let observed!: () => void;
    const nativeReadComplete = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let deliver: (() => void) | undefined;
    const input = vi.mocked(read).mockImplementationOnce((fd, callback) => {
      expect(fd).toBe(handle.fd);
      native.read(fd, (error, bytesRead, buffer) => {
        // Preserve the real result; gate its delivery to expose an abort race.
        deliver = () => callback(error, bytesRead, buffer);
        observed();
      });
    });
    try {
      const controller = new AbortController();
      const pending = readHostRuntimeRequest(handle.fd, controller.signal);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await nativeReadComplete;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect((await handle.stat()).isFile()).toBe(true);
      deliver!();
      deliver = undefined;
      await expect(pending).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect(input).toHaveBeenCalledTimes(1);
      expect((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead).toBe(0);
    } finally {
      deliver?.();
      input.mockRestore();
      await handle.close();
    }
  });

  it("binds candidate R/T separately from source H and rejects substitution", () => {
    const base = requestFor("/srv/candidate", "/srv/state", "c".repeat(40), "d".repeat(40), {
      workflow: "review-documentation",
    });
    const candidateBody = {
      schemaVersion: 1,
      kind: "docsfab-candidate-review-binding",
      requestKey: base.requestKey,
      sourceBaseRevision: "a".repeat(40),
      sourceHeadRevision: "b".repeat(40),
      sourceHeadTreeObjectId: "e".repeat(40),
      sourceManifestSha256: "1".repeat(64),
      sourceImpactSha256: "2".repeat(64),
      targetManifestSha256: "3".repeat(64),
      targets: [
        { path: "docs/guide.md", operations: ["modify"], preimageObjectId: "f".repeat(40) },
      ],
      candidateTreeObjectId: base.sourceTreeObjectId,
      reviewCommitObjectId: base.revision,
      patchSha256: "4".repeat(64),
      policySha256: "5".repeat(64),
      contextAuthoritySha256: "6".repeat(64),
      authorRunRecordSha256: "7".repeat(64),
      authorDispatcherReceiptSha256: "8".repeat(64),
      authorExecutionIdentitySha256: "9".repeat(64),
      authorSessionSha256: "a".repeat(64),
      reviewerSessionSha256: "b".repeat(64),
      requestIdentitySha256: digest({
        requestKey: base.requestKey,
        mappedIdentity: base.origin.principalId,
        requestId: base.origin.requestId,
      }),
    };
    const candidateReview = { ...candidateBody, bindingSha256: digest(candidateBody) };
    const parsed = parseHostRuntimeRequest({
      ...base,
      packet: {
        packetFingerprintSha256: base.packet.packetFingerprintSha256,
        inputManifest: null,
        canon: null,
        reviewEvent: null,
        candidateReview,
      },
    });
    expect(parsed.revision).toBe(candidateReview.reviewCommitObjectId);
    expect(parsed.sourceTreeObjectId).toBe(candidateReview.candidateTreeObjectId);
    expect(parsed.packet.candidateReview?.sourceHeadRevision).toBe(
      candidateReview.sourceHeadRevision,
    );
    expect(() =>
      parseHostRuntimeRequest({
        ...parsed,
        revision: "0".repeat(40),
      }),
    ).toThrowError(/candidate-review-binding-mismatch/u);
    expect(() =>
      parseHostRuntimeRequest({
        ...parsed,
        packet: {
          ...parsed.packet,
          candidateReview: { ...candidateReview, policySha256: "0".repeat(64) },
        },
      }),
    ).toThrowError(/candidate-review-digest-mismatch/u);
    const runtimeRecord = {
      schemaVersion: 2,
      id: parsed.runId,
      workflow: parsed.workflow,
      repository: { revision: parsed.revision },
      status: "succeeded",
      steps: parsed.stepIds.map((id) => ({ id })),
      tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
      models: [
        {
          provider: "offline-fixture",
          model: parsed.composition.compositionSha256.slice(0, 16),
        },
      ],
      securityScan: {},
    };
    const candidateReviewResult = {
      schemaVersion: 2,
      kind: "docsfab-review-result",
      reviewedHeadSha: parsed.revision,
      resultSha256: "f".repeat(64),
    };
    const terminal = sealHostRuntimeTerminal({
      request: parsed,
      status: "succeeded",
      runtimeRecord,
      patch: null,
      candidateReviewResult,
    });
    expect(terminal.runRecord.candidateReviewResult).toEqual(candidateReviewResult);
    expect(terminal.runRecord.evidence.candidateReviewResultSha256).toBe(
      digest(candidateReviewResult),
    );
    const substituted = structuredClone(terminal);
    (substituted.runRecord.candidateReviewResult as { reviewedHeadSha: string }).reviewedHeadSha =
      "0".repeat(40);
    expect(() => parseHostRuntimeTerminal(substituted, parsed)).toThrowError(
      /terminal-candidate-review-evidence/u,
    );
    const historical = sealHostRuntimeTerminal({
      request: parsed,
      status: "succeeded",
      runtimeRecord,
      patch: null,
    });
    expect(
      parseHostRuntimeTerminal(historical, parsed).runRecord.candidateReviewResult,
    ).toBeUndefined();
  });

  it("runs the installed read-only review workflow on R/T while retaining source H", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-candidate-runtime-"));
    roots.push(root);
    const repository = join(root, "repository");
    await mkdir(join(repository, "docs"), { recursive: true });
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, "docs", "guide.md"), "# Source guide\n");
    await writeFile(join(repository, "src", "feature.ts"), "export const value = 1;\n");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["add", "."], { cwd: repository });
    await exec(
      "git",
      [
        "-c",
        "user.name=DocsFab Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "base source",
      ],
      { cwd: repository },
    );
    const sourceBaseRevision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: repository })
    ).stdout.trim();
    await writeFile(join(repository, "src", "feature.ts"), "export const value = 2;\n");
    await exec("git", ["add", "."], { cwd: repository });
    await exec(
      "git",
      [
        "-c",
        "user.name=DocsFab Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "source change",
      ],
      { cwd: repository },
    );
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    const headTree = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })
    ).stdout.trim();
    const preimage = (
      await exec("git", ["rev-parse", "HEAD:docs/guide.md"], { cwd: repository })
    ).stdout.trim();
    await writeFile(join(repository, "docs", "guide.md"), "# Candidate guide\n");
    await exec("git", ["add", "."], { cwd: repository });
    await exec(
      "git",
      [
        "-c",
        "user.name=DocsFab Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "candidate",
      ],
      { cwd: repository },
    );
    const reviewCommitObjectId = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: repository })
    ).stdout.trim();
    const candidateTreeObjectId = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })
    ).stdout.trim();
    const scope = sealedScope({
      targets: [{ path: "docs/guide.md", reason: "operator-named" }],
      deferred: [],
      corpusFileCount: 1,
    });
    const base = requestFor(
      repository,
      join(root, "state"),
      reviewCommitObjectId,
      candidateTreeObjectId,
      {
        workflow: "review-documentation",
        reviewScope: scope,
      },
    );
    const candidateBody = {
      schemaVersion: 1,
      kind: "docsfab-candidate-review-binding",
      requestKey: base.requestKey,
      sourceBaseRevision,
      sourceHeadRevision: head,
      sourceHeadTreeObjectId: headTree,
      sourceManifestSha256: digest([
        { path: "src/feature.ts", status: "modified", previousPath: null },
      ]),
      sourceImpactSha256: "2".repeat(64),
      targetManifestSha256: "3".repeat(64),
      targets: [{ path: "docs/guide.md", operations: ["modify"], preimageObjectId: preimage }],
      candidateTreeObjectId,
      reviewCommitObjectId,
      patchSha256: "4".repeat(64),
      policySha256: "5".repeat(64),
      contextAuthoritySha256: "6".repeat(64),
      authorRunRecordSha256: "7".repeat(64),
      authorDispatcherReceiptSha256: "8".repeat(64),
      authorExecutionIdentitySha256: "9".repeat(64),
      authorSessionSha256: "a".repeat(64),
      reviewerSessionSha256: "b".repeat(64),
      requestIdentitySha256: digest({
        requestKey: base.requestKey,
        mappedIdentity: base.origin.principalId,
        requestId: base.origin.requestId,
      }),
    };
    const request = parseHostRuntimeRequest({
      ...base,
      packet: {
        packetFingerprintSha256: base.packet.packetFingerprintSha256,
        inputManifest: null,
        canon: null,
        reviewEvent: null,
        reviewScope: scope,
        candidateReview: { ...candidateBody, bindingSha256: digest(candidateBody) },
      },
    });
    const observedInstructions: string[] = [];
    const observedSourceEvidence: unknown[] = [];
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit: () => undefined,
      executionHarness: {
        async runStep(input) {
          observedInstructions.push(input.instruction ?? "");
          observedSourceEvidence.push(input.candidateReviewSourceEvidence);
          const sourceObligationProposal =
            input.step.id === "derive-source-obligations"
              ? sourceObligationProposalFixture("docs/guide.md:1")
              : undefined;
          const verification =
            input.step.skill === "verify-technical-accuracy" &&
            input.step.id !== "derive-source-obligations"
              ? await verificationFixture(input)
              : {};
          return {
            summary: sourceObligationProposal
              ? canonicalSourceObligationProposal(sourceObligationProposal)
              : `captured ${input.step.id}`,
            ...(sourceObligationProposal ? { sourceObligationProposal } : {}),
            ...verification,
          };
        },
      },
    });
    expect(result.record.status, JSON.stringify(result.record)).toBe("succeeded");
    expect(result.record.repository.revision).toBe(reviewCommitObjectId);
    expect(request.packet.candidateReview?.sourceHeadRevision).toBe(head);
    expect(request.sourceTreeObjectId).toBe(candidateTreeObjectId);
    expect(request.allowWrite).toBe(false);
    expect(result.patch).toBeNull();
    expect(observedInstructions.length).toBeGreaterThan(0);
    expect(new Set(observedInstructions).size).toBe(1);
    const instruction = observedInstructions[0]!;
    expect(instruction).not.toContain("Candidate source changes");
    expect(instruction).not.toContain("export const value = 1");
    expect(instruction).not.toContain("export const value = 2");
    expect(instruction).not.toContain(candidateBody.authorSessionSha256);
    expect(observedSourceEvidence).toHaveLength(observedInstructions.length);
    expect(new Set(observedSourceEvidence.map((value) => JSON.stringify(value))).size).toBe(1);
    const sourceEvidence = observedSourceEvidence[0] as {
      source: { baseRevision: string; headRevision: string };
      candidate: { treeObjectId: string };
      changes: readonly [{ before: { content: string }; after: { content: string } }];
    };
    expect(Object.isFrozen(sourceEvidence)).toBe(true);
    expect(Object.isFrozen(sourceEvidence.changes)).toBe(true);
    expect(Object.isFrozen(sourceEvidence.changes[0].before)).toBe(true);
    expect(sourceEvidence.source.baseRevision).toBe(sourceBaseRevision);
    expect(sourceEvidence.source.headRevision).toBe(head);
    expect(sourceEvidence.candidate.treeObjectId).toBe(candidateTreeObjectId);
    expect(sourceEvidence.changes[0].before.content).toBe("export const value = 1;\n");
    expect(sourceEvidence.changes[0].after.content).toBe("export const value = 2;\n");
    expect(JSON.stringify(sourceEvidence)).not.toContain(candidateBody.authorSessionSha256);
  });

  it("carries full UTF-8 reader intent through the actual update request descriptor boundary", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    const requestText = "漢".repeat(LIMIT_DEFINITION_BY_NAME["host.slack.transportTextChars"]!.max);
    const readerTask = sealHostRuntimeReaderTask({
      schemaVersion: 1,
      kind: "docsfab-reader-task-evidence",
      readerContextInput: conservativeReaderContextInput({
        instruction: requestText,
        changeScope: ["docs/guide.md"],
      }),
      inputOrigin: "conservative-fallback",
      requestText,
      operatorInput: { requestText, targetPaths: ["docs/guide.md"] },
      comparison: {
        kind: "base-head",
        baseRevision: fixture.revision,
        headRevision: fixture.revision,
      },
      sources: [{ role: "current-documentation", path: "docs/guide.md" }],
    });
    const request = parseHostRuntimeRequest({
      ...writeRequestBody(fixture, authority),
      packet: { ...(writeRequestBody(fixture, authority).packet as object), readerTask },
      readerEvidencePolicy: sealHostRuntimeReaderEvidencePolicy({
        schemaVersion: 2,
        workflow: "update-documentation",
        readScope: "bound-tracked-repository",
        sourceRoles: ["current-documentation", "request"],
        maximumSourceNominations: 128,
      }),
    });
    await mkdir(fixture.state, { recursive: true, mode: 0o700 });
    const path = join(fixture.state, "reader-request.json");
    const serialized = JSON.stringify(request);
    const maximum = hostedRequestMaximumBytes("update-documentation");
    expect(maximum).toBe(HOST_RUNTIME_READER_REQUEST_MAXIMUM_BYTES);
    expect(maximum).toBeGreaterThan(hostedRequestMaximumBytes("review-documentation"));
    for (const extra of [0, 1]) {
      await writeFile(
        path,
        serialized + " ".repeat(maximum - Buffer.byteLength(serialized) + extra),
      );
      const fd = openSync(path, "r");
      try {
        if (extra === 0) {
          const received = (await readHostRuntimeRequest(fd)).packet.readerTask;
          expect(received?.requestText).toBe(requestText);
          expect(received?.operatorInput).toEqual(readerTask.operatorInput);
        } else await expect(readHostRuntimeRequest(fd)).rejects.toThrow(/request-max-bytes-bound/u);
      } finally {
        try {
          closeSync(fd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
        }
      }
    }
  });

  it("disposes source and editorial evidence resources when later hosted setup fails", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    const readerTask = sealHostRuntimeReaderTask({
      schemaVersion: 1,
      kind: "docsfab-reader-task-evidence",
      readerContextInput: {
        schema_version: 1,
        target_audience: "DocsFab operators",
        reader_job: "Use the current hosted guide.",
        change_scope: ["docs/guide.md"],
        source_priority: ["current documentation"],
        required_content: ["the current hosted behavior"],
        excluded_content: [],
        unresolved_questions: [],
      },
      inputOrigin: "explicit",
      comparison: {
        kind: "base-head",
        baseRevision: fixture.revision,
        headRevision: fixture.revision,
      },
      sources: [{ role: "current-documentation", path: "docs/guide.md" }],
    });
    const request = parseHostRuntimeRequest({
      ...writeRequestBody(fixture, authority),
      packet: { ...(writeRequestBody(fixture, authority).packet as object), readerTask },
      readerEvidencePolicy: sealHostRuntimeReaderEvidencePolicy({
        workflow: "update-documentation",
        sourceRoles: ["public-contract", "changed-source", "current-documentation", "request"],
        pathCeiling: ["docs/", "src/"],
        maximumSourceNominations: 8,
      }),
    });
    const sourceDispose = vi.fn(async () => undefined);
    const evidenceDispose = vi.fn(async () => undefined);
    const sourceWorkspaceSpy = vi
      .spyOn(workspaceMaterialize, "prepareRepositoryWorkspace")
      .mockResolvedValue({
        path: "/tmp/hosted-source-workspace",
        sourcePath: fixture.repository,
        requestedRevision: fixture.revision,
        revision: fixture.revision,
        dispose: sourceDispose,
      });
    const repositoryEvidenceSpy = vi.spyOn(GitPatchEvidenceCollector, "create").mockResolvedValue({
      dispose: evidenceDispose,
    } as never);

    try {
      await expect(
        runHostedWorkflow({
          request: { ...request, stateDirectory: "" },
          credential: null,
          emit: () => undefined,
        }),
      ).rejects.toMatchObject({ code: "invalid-root" });
      expect(sourceDispose).toHaveBeenCalledOnce();
      expect(evidenceDispose).toHaveBeenCalledOnce();
    } finally {
      sourceWorkspaceSpy.mockRestore();
      repositoryEvidenceSpy.mockRestore();
    }
  });

  it("refuses unbound or unsafe candidate source evidence before the review harness", async () => {
    const safe = await candidateSourceFixture(
      "export const value = 1;\n",
      "export const value = 2;\n",
    );
    let harnessCalls = 0;
    const harness = {
      async runStep() {
        harnessCalls += 1;
        return { summary: "must not run" };
      },
    };
    const rebind = (overrides: Record<string, unknown>) => {
      const body = { ...safe.candidateBody, ...overrides };
      return parseHostRuntimeRequest({
        ...safe.request,
        packet: {
          ...safe.request.packet,
          candidateReview: { ...body, bindingSha256: digest(body) },
        },
      });
    };
    const mismatchedManifest = rebind({
      sourceManifestSha256: digest([{ path: "src/other.ts", status: "added", previousPath: null }]),
    });
    await expect(
      runHostedWorkflow({
        request: mismatchedManifest,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow(/manifest-mismatch/u);
    const missingBase = rebind({ sourceBaseRevision: "0".repeat(40) });
    await expect(
      runHostedWorkflow({
        request: missingBase,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow(/git-unavailable/u);
    const substitutedHead = rebind({ sourceHeadRevision: safe.candidateBody.sourceBaseRevision });
    await expect(
      runHostedWorkflow({
        request: substitutedHead,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow(/identity-mismatch/u);

    const binary = await candidateSourceFixture("plain\n", Buffer.from([0xff, 0x00]));
    await expect(
      runHostedWorkflow({
        request: binary.request,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow(/unsupported-encoding/u);
    // DocsFab's own configured credential, which looks like no credential,
    // refuses before the review harness. Source that only looks like a
    // credential is reviewed instead (#1807); see
    // candidate-review-evidence-credentials.test.ts.
    const planted = plainConfiguredCredential("candidate-source");
    const credential = await candidateSourceFixture(
      "plain\n",
      `export const marker = "${planted}";\n`,
    );
    plantConfiguredCredential(planted);
    try {
      await expect(
        runHostedWorkflow({
          request: credential.request,
          credential: null,
          emit: () => undefined,
          executionHarness: harness,
        }),
      ).rejects.toThrow(/credential-material/u);
    } finally {
      clearPlantedCredential();
    }
    const oversize = await candidateSourceFixture("plain\n", "x".repeat(96 * 1024 + 1));
    await expect(
      runHostedWorkflow({
        request: oversize.request,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow(/file-size/u);
    const aggregateOversize = await candidateSourceFixture(
      "x".repeat(70 * 1024),
      "y".repeat(70 * 1024),
    );
    await expect(
      runHostedWorkflow({
        request: aggregateOversize.request,
        credential: null,
        emit: () => undefined,
        executionHarness: harness,
      }),
    ).rejects.toThrow(/aggregate-size/u);
    expect(harnessCalls).toBe(0);
  });

  it("keeps offline public review verification explicitly unverified", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-host-offline-review-"));
    roots.push(root);
    const repository = join(root, "repository");
    await mkdir(repository);
    await writeFile(join(repository, "README.md"), "# Fixture documentation\n");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["add", "."], { cwd: repository });
    await exec(
      "git",
      [
        "-c",
        "user.name=DocsFab Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: repository },
    );
    const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    const tree = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })
    ).stdout.trim();
    const workflow = getWorkflow("review-documentation");
    const declaredTools = [
      ...new Set(workflow.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search))),
    ].sort();
    const request = parseHostRuntimeRequest({
      ...requestFor(repository, join(root, "state"), revision, tree),
      toolPolicySha256: digest({
        workflow: workflow.name,
        stepIds: workflow.steps.map((step) => step.id),
        declaredTools,
      }),
      workflow: workflow.name,
      stepIds: workflow.steps.map((step) => step.id),
      composition: sealHostRuntimeComposition({
        compositionId: "offline-review-v1",
        route: "offline-fixture",
        credentialFamily: "none",
        executionProfile: null,
        declaredTools: [
          ...new Set(
            workflow.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search)),
          ),
        ].sort(),
      }),
    });
    // A read-only review takes no patch baseline; only granted write
    // workflows (UPDATE, bootstrap, RESTRUCTURE, CREATE) snapshot the checkout.
    const collectorCreate = vi.spyOn(GitPatchEvidenceCollector, "create");
    let result: Awaited<ReturnType<typeof runHostedWorkflow>>;
    try {
      result = await runHostedWorkflow({ request, credential: null, emit: () => undefined });
      expect(collectorCreate).not.toHaveBeenCalled();
    } finally {
      collectorCreate.mockRestore();
    }
    expect(result.record.status, JSON.stringify(result.record)).toBe("succeeded");
    const inventory = result.record.steps.find((step) => step.id === "derive-source-obligations")!;
    expect(JSON.parse(inventory.summary!)).toMatchObject({
      kind: "docsfab-source-obligation-ledger",
      schemaVersion: 2,
      completeness: "bounded-not-proven",
      identity: expect.objectContaining({
        repositoryRevision: revision,
        originalSourceAuthority: expect.any(Object),
      }),
      dimensions: expect.arrayContaining([
        expect.objectContaining({
          dimension: "input-representations",
          status: "not-applicable",
        }),
      ]),
    });
    expect(JSON.parse(inventory.summary!).dimensions).toHaveLength(6);
    const verification = result.record.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    expect(JSON.parse(verification.summary!)).toMatchObject({
      review: { verdict: "human-review", issues: [] },
      coverage: [{ path: "README.md", status: "unverified", evidence: [] }],
    });
    const lint = result.record.steps.find((step) => step.id === "lint-documentation")!;
    expect(JSON.parse(lint.summary!)).toMatchObject({ status: "unavailable" });
    expect(result.patch).toBeNull();
  });

  it("runs an actual catalog workflow against one exact temporary Git commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-host-invoker-"));
    roots.push(root);
    const repository = join(root, "repository");
    const state = join(root, "state");
    await mkdir(join(repository, "docs"), { recursive: true });
    await writeFile(join(repository, "README.md"), "# Exact fixture\n");
    await writeFile(join(repository, "docs", "guide.md"), "# Guide\n\nBounded source.\n");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["config", "user.name", "DocsFab Test"], { cwd: repository });
    await exec("git", ["config", "user.email", "docsfab-test@example.invalid"], {
      cwd: repository,
    });
    await exec("git", ["add", "."], { cwd: repository });
    await exec("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    });
    const revision = stdout.trim();
    const treeObjectId = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" })
    ).stdout.trim();
    const request = requestFor(repository, state, revision, treeObjectId);
    const events: unknown[] = [];
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit: (event) => events.push(event),
    });

    expect(result.record.status, JSON.stringify(result.record, null, 2)).toBe("succeeded");
    expect(result.record.id).toBe("run-exact-fixture");
    expect(result.record.repository.revision).toBe(revision);
    expect(result.record.workspace.disposable).toBe(true);
    expect(result.record.steps).toHaveLength(1);
    expect(result.record.tools.byTool.map((item) => item.name).sort()).toEqual(tools);
    expect(result.patch).toBeNull();
    expect(result.editorialOutcome).toMatchObject({
      state: "unavailable",
      outcome: "unavailable",
      limitations: ["editorial-evidence-unavailable"],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run-status", status: "running" }),
        expect.objectContaining({ type: "step-status", status: "succeeded" }),
        expect.objectContaining({ type: "run-status", status: "succeeded" }),
      ]),
    );
    const retained = await readFile(join(state, "run-exact-fixture.json"), "utf8");
    expect(retained).not.toContain("credential");
    const terminal = sealHostRuntimeTerminal({
      request,
      status: "succeeded",
      runtimeRecord: result.record,
      patch: result.patch,
    });
    expect(terminal.runRecord.editorialOutcome).toBeUndefined();
    expect(terminal.runRecord.evidence).not.toHaveProperty("editorialOutcomeSha256");
    expect(terminal.runRecord.binding.packetFingerprintSha256).toBe("e".repeat(64));
    expect(() =>
      parseHostRuntimeTerminal(
        {
          ...terminal,
          runRecord: {
            ...terminal.runRecord,
            binding: { ...terminal.runRecord.binding, projectId: "substituted" },
          },
        },
        request,
      ),
    ).toThrowError(expect.objectContaining({ code: "terminal-binding-mismatch" }));
    expect(() =>
      parseHostRuntimeTerminal(
        {
          ...terminal,
          runRecord: {
            ...terminal.runRecord,
            runtimeRecord: {
              ...(terminal.runRecord.runtimeRecord as Record<string, unknown>),
              steps: [{ id: "unknown-step" }],
            },
          },
        },
        request,
      ),
    ).toThrowError(expect.objectContaining({ code: "terminal-evidence-mismatch" }));
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: { ...result.record, steps: [{ id: "unknown-step" }] },
        patch: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-step-substitution" }));
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: {
          ...result.record,
          tools: {
            ...result.record.tools,
            byTool: [{ name: "shell", calls: 1, failures: 0 }],
          },
        },
        patch: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-tool-substitution" }));
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "failed",
        runtimeRecord: result.record,
        patch: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-status-mismatch" }));
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: result.record,
        patch: "diff --git a/a b/a",
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-patch-not-authorized" }));

    const selectedStepIds = [
      "plan-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ];
    const installedUpdateStepIds = getWorkflow("update-documentation").steps.map((step) => step.id);
    const updateRequest = parseHostRuntimeRequest({
      ...request,
      workflow: "update-documentation",
      stepIds: installedUpdateStepIds,
      toolPolicySha256: digest({
        workflow: "update-documentation",
        stepIds: installedUpdateStepIds,
        declaredTools: request.composition.declaredTools,
      }),
    });
    const noChangeRecord = {
      ...result.record,
      workflow: "update-documentation" as const,
      steps: selectedStepIds.map((id) => ({
        ...result.record.steps[0]!,
        id,
        title: id,
        mode: "read-only" as const,
      })),
      workflowBranchCoverage: {
        selection: { branchId: "assess-no-change" },
      },
    };
    const editorialOutcome = verifiedNoChangeOutcome(revision);
    const editorialAuthority = {
      project: (record: Readonly<Record<string, unknown>>) => {
        if (digest(record) !== digest(noChangeRecord))
          throw new Error("unexpected retained record");
        return editorialOutcome;
      },
    };
    expect(() =>
      sealHostRuntimeTerminal({
        request: updateRequest,
        status: "succeeded",
        runtimeRecord: noChangeRecord,
        patch: null,
        editorialOutcome,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-step-substitution" }));
    const noChangeTerminal = sealHostRuntimeTerminal({
      request: updateRequest,
      status: "succeeded",
      runtimeRecord: noChangeRecord,
      patch: null,
      editorialOutcome,
      editorialAuthority,
    });
    expect(noChangeTerminal.runRecord.editorialOutcome).toEqual(editorialOutcome);
    expect(noChangeTerminal.runRecord.evidence.editorialOutcomeSha256).toBe(
      digest(editorialOutcome),
    );
    expect(parseHostRuntimeTerminalWire(noChangeTerminal, updateRequest).status).toBe("succeeded");
    const noPresentationTerminal = sealHostRuntimeTerminal({
      request: updateRequest,
      status: "succeeded",
      runtimeRecord: noChangeRecord,
      patch: null,
      editorialAuthority,
    });
    expect(noPresentationTerminal.runRecord.editorialOutcome).toBeUndefined();
    expect(
      parseHostRuntimeTerminal(noPresentationTerminal, updateRequest, editorialAuthority).status,
    ).toBe("succeeded");
    const readerTask = sealHostRuntimeReaderTask({
      schemaVersion: 1,
      kind: "docsfab-reader-task-evidence",
      readerContextInput: {
        schema_version: 1,
        target_audience: "DocsFab operators",
        reader_job: "Use the hosted documentation update.",
        change_scope: ["docs/guide.md"],
        source_priority: ["current documentation"],
        required_content: ["the hosted update behavior"],
        excluded_content: [],
        unresolved_questions: [],
      },
      inputOrigin: "explicit",
      comparison: {
        kind: "base-head",
        baseRevision: "a".repeat(40),
        headRevision: revision,
      },
      sources: [{ role: "current-documentation", path: "docs/guide.md" }],
    });
    const readerEvidencePolicy = sealHostRuntimeReaderEvidencePolicy({
      workflow: "update-documentation",
      sourceRoles: ["current-documentation"],
      pathCeiling: ["docs/"],
      maximumSourceNominations: 1,
    });
    const readerUpdateRequest = parseHostRuntimeRequest({
      ...updateRequest,
      packet: { ...updateRequest.packet, readerTask },
      readerEvidencePolicy,
    });
    const noGraphRecord = {
      ...result.record,
      workflow: "update-documentation" as const,
      steps: installedUpdateStepIds.map((id) => ({
        ...result.record.steps[0]!,
        id,
        title: id,
      })),
    };
    expect(() =>
      sealHostRuntimeTerminal({
        request: readerUpdateRequest,
        status: "succeeded",
        runtimeRecord: noGraphRecord,
        patch: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-editorial-authority-unavailable" }));
    expect(() =>
      parseHostRuntimeTerminal(
        {
          ...noChangeTerminal,
          runRecord: {
            ...noChangeTerminal.runRecord,
            editorialOutcome: {
              ...editorialOutcome,
              limitations: ["tampered-after-admission"],
            },
          },
        },
        updateRequest,
        editorialAuthority,
      ),
    ).toThrowError(expect.objectContaining({ code: "terminal-evidence-mismatch" }));
    expect(() =>
      sealHostRuntimeTerminal({
        request: updateRequest,
        status: "succeeded",
        runtimeRecord: {
          ...noChangeRecord,
          workflowBranchCoverage: { selection: { branchId: "author" } },
        },
        patch: null,
        editorialOutcome,
        editorialAuthority: {
          project: () => ({ ...editorialOutcome, limitations: ["substituted"] }),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-editorial-authority-mismatch" }));
    expect(() =>
      parseHostRuntimeTerminal(noChangeTerminal, updateRequest, {
        project: () => ({ ...editorialOutcome, evidenceRefs: [] }),
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-editorial-authority-mismatch" }));
  });

  it("carries a host-resolved focused scope through the hosted runner into the record and the admitted terminal", async () => {
    // runHostedWorkflow rebuilds RunRequest.reviewScope field by field from the
    // packet, so this drives that seam with a scoped packet.
    const root = await mkdtemp(join(tmpdir(), "docsfab-host-invoker-scope-"));
    roots.push(root);
    const repository = join(root, "repository");
    const state = join(root, "state");
    await mkdir(join(repository, "docs", "home"), { recursive: true });
    await writeFile(join(repository, "README.md"), "# Exact fixture\n");
    await writeFile(join(repository, "docs", "guide.md"), "# Guide\n\nBounded source.\n");
    await writeFile(join(repository, "docs", "home", "index.md"), "# Home\n");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["config", "user.name", "DocsFab Test"], { cwd: repository });
    await exec("git", ["config", "user.email", "docsfab-test@example.invalid"], {
      cwd: repository,
    });
    await exec("git", ["add", "."], { cwd: repository });
    await exec("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
    const revision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })
    ).stdout.trim();
    const treeObjectId = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" })
    ).stdout.trim();
    // The denominator the host binds at dispatch, counted with the rule of the
    // host's `countTrackedDocumentationPages`: every tracked `.md` path at the
    // revision (README.md, docs/guide.md, docs/home/index.md).
    const corpusFileCount = (
      await exec("git", ["ls-tree", "-r", "-z", "--name-only", revision], {
        cwd: repository,
        encoding: "utf8",
      })
    ).stdout
      .split("\0")
      .filter((entry) => entry.endsWith(".md")).length;
    expect(corpusFileCount).toBe(3);
    // A page under `home/` on purpose: the runtime must not re-read it as a
    // host path anywhere on this seam.
    const scope = sealedScope({
      targets: [{ path: "docs/home/index.md", reason: "operator-named" }],
      deferred: [{ path: "docs/guide.md", reason: "over-budget" }],
      corpusFileCount,
    });
    const request = requestFor(repository, state, revision, treeObjectId, {
      workflow: "review-documentation",
      reviewScope: scope,
    });

    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit: () => undefined,
    });

    expect(result.record.status, JSON.stringify(result.record, null, 2)).toBe("succeeded");
    expect(result.record.steps.map((step) => step.id)).toEqual(
      getWorkflow("review-documentation").steps.map((step) => step.id),
    );
    expect(result.record.reviewScope).toEqual({
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["docs/home/index.md"],
      deferredPaths: ["docs/guide.md"],
      anchorPaths: [],
      scopeSha256: scope.scopeSha256,
      corpusFileCount,
    });
    const terminal = sealHostRuntimeTerminal({
      request,
      status: "succeeded",
      runtimeRecord: result.record,
      patch: result.patch,
    });
    const admitted = parseHostRuntimeTerminal(terminal, request);
    expect((admitted.runRecord.runtimeRecord as { reviewScope?: unknown }).reviewScope).toEqual(
      result.record.reviewScope,
    );

    // The runner carries the host-bound denominator instead of recounting the
    // workspace; terminal admission requires the record to equal the host's
    // value. This value is one a workspace recount cannot produce.
    const carried = corpusFileCount + 1;
    const carriedScope = sealedScope({
      targets: [{ path: "docs/home/index.md", reason: "operator-named" }],
      deferred: [{ path: "docs/guide.md", reason: "over-budget" }],
      corpusFileCount: carried,
    });
    const carriedRequest = requestFor(
      repository,
      join(root, "state-carried"),
      revision,
      treeObjectId,
      {
        workflow: "review-documentation",
        reviewScope: carriedScope,
      },
    );
    const carriedResult = await runHostedWorkflow({
      request: carriedRequest,
      credential: null,
      emit: () => undefined,
    });
    expect(carriedResult.record.reviewScope?.corpusFileCount).toBe(carried);
    expect(() =>
      parseHostRuntimeTerminal(
        sealHostRuntimeTerminal({
          request: carriedRequest,
          status: "succeeded",
          runtimeRecord: carriedResult.record,
          patch: carriedResult.patch,
        }),
        carriedRequest,
      ),
    ).not.toThrow();
    // Two six-step offline runs plus repository scans and Git checks.
  }, 60_000);

  it("rejects composition substitution and native routes are typed preflight-only", async () => {
    const composition = sealHostRuntimeComposition({
      compositionId: "offline-v1",
      route: "offline-fixture",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools: tools,
    });
    expect(() =>
      parseHostRuntimeRequest({
        ...requestFor("/tmp/workspace", "/tmp/state", "a".repeat(40)),
        composition: { ...composition, compositionId: "substituted" },
      }),
    ).toThrowError(HostRuntimeContractError);
    const capsuleRequest = requestFor("/tmp/workspace", "/tmp/state", "a".repeat(40));
    expect(() =>
      parseHostRuntimeRequest({
        ...capsuleRequest,
        capsule: {
          ...capsuleRequest.capsule,
          selectedEvidence: [{ evidenceId: "substituted", content: "different" }],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "capsule-digest-mismatch" }));
    expect(() =>
      parseHostRuntimeProgress(
        {
          schemaVersion: 1,
          kind: "docsfab-host-runtime-event",
          sequence: 1,
          type: "step-status",
          runId: capsuleRequest.runId,
          stepId: "unknown-step",
          status: "running",
        },
        capsuleRequest,
      ),
    ).toThrowError(expect.objectContaining({ code: "progress-step-substitution" }));
    expect(() =>
      parseHostRuntimeProgress(
        {
          schemaVersion: 1,
          kind: "docsfab-host-runtime-event",
          sequence: 1,
          type: "run-status",
          runId: capsuleRequest.runId,
          status: "complete-ish",
        },
        capsuleRequest,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-enum" }));
    const native = sealHostRuntimeComposition({
      compositionId: "native-codex-v1",
      route: "native-codex",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools: tools,
    });
    const parsed = parseHostRuntimeRequest({
      ...requestFor("/tmp/workspace", "/tmp/state", "b".repeat(40)),
      composition: native,
    });
    await expect(
      runHostedWorkflow({ request: parsed, credential: null, emit: () => undefined }),
    ).rejects.toMatchObject({ name: "UnsupportedNativeCompositionError" });
  });

  it("rejects executable local Git config without invoking a hanging fsmonitor", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-host-git-boundary-"));
    roots.push(root);
    const repository = join(root, "repository");
    const state = join(root, "state");
    const marker = join(root, "fsmonitor-called");
    const monitor = join(root, "hang-fsmonitor.sh");
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "README.md"), "# Trusted revision\n");
    await exec("git", ["init", "-q"], { cwd: repository });
    await exec("git", ["config", "user.name", "DocsFab Test"], { cwd: repository });
    await exec("git", ["config", "user.email", "docsfab-test@example.invalid"], {
      cwd: repository,
    });
    await exec("git", ["add", "."], { cwd: repository });
    await exec("git", ["commit", "-q", "-m", "trusted"], { cwd: repository });
    const revision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })
    ).stdout.trim();
    const tree = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" })
    ).stdout.trim();
    await writeFile(join(repository, "README.md"), "# Replacement revision\n");
    await exec("git", ["commit", "-qam", "replacement"], { cwd: repository });
    const replacement = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })
    ).stdout.trim();
    await exec("git", ["reset", "--hard", revision], { cwd: repository });
    await exec("git", ["replace", revision, replacement], { cwd: repository });
    await writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\nsleep 30\n`);
    await chmod(monitor, 0o700);
    await exec("git", ["config", "core.fsmonitor", monitor], { cwd: repository });
    await exec("git", ["config", "credential.helper", "!sleep 30"], { cwd: repository });
    await exec("git", ["config", "protocol.file.allow", "always"], { cwd: repository });

    // A reachability pin, not a vocabulary pin: it asserts the class, the
    // family and one short anchor. `test/workspace.test.ts` pins the sentences.
    const caught = await runHostedWorkflow({
      request: requestFor(repository, state, revision, tree),
      credential: null,
      emit: () => undefined,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(RepositoryConfigurationRefusalError);
    expect((caught as RepositoryConfigurationRefusalError).code).toBe("filesystem-monitor");
    expect((caught as RepositoryConfigurationRefusalError).message).toContain(
      "sets core.fsmonitor",
    );
    await expect(access(marker)).rejects.toThrow();
  });

  it("admits four explicit provider routes and deeply rejects profile credential smuggling", () => {
    const routes = [
      ["openai-direct", "openai-api", "openai-chat-completions", "chat_completions"],
      ["anthropic-direct", "anthropic-api", "anthropic-messages", "messages"],
      ["nvidia-api-catalog", "nvidia-api-catalog", "openai-chat-completions", "chat_completions"],
      [
        "nvidia-inference-api",
        "nvidia-inference-api",
        "openai-chat-completions",
        "chat_completions",
      ],
    ] as const;
    for (const [route, credentialFamily, transport, apiFormat] of routes) {
      const composition = sealHostRuntimeComposition({
        compositionId: `${route}-v1`,
        route,
        credentialFamily,
        executionProfile: executionProfile(route, transport, apiFormat),
        declaredTools: tools,
      });
      expect(composition.route).toBe(route);
      expect(composition.executionProfile?.routeId).toBe(route);
    }
    const profile = executionProfile(
      "openai-direct",
      "openai-chat-completions",
      "chat_completions",
    );
    const smuggle = (approvedSource: string) =>
      sealHostRuntimeComposition({
        compositionId: "smuggled-v1",
        route: "openai-direct",
        credentialFamily: "openai-api",
        executionProfile: {
          ...profile,
          profile: {
            ...profile.profile,
            metadata: { ...profile.profile.metadata, approvedSource },
          },
        },
        declaredTools: tools,
      });
    // DocsFab's own configured credential is refused deep in the profile; it
    // looks like no credential, so only the exact match can refuse that value. See #1807.
    const planted = plantConfiguredCredential();
    try {
      expect(() => smuggle(planted)).toThrowError(
        expect.objectContaining({ code: "credential-material" }),
      );
    } finally {
      clearPlantedCredential();
    }
    // A value that only looks like a key is sealed and recorded.
    const shaped = collectCredentialFindings(() => smuggle(`sk-${"x".repeat(24)}`));
    expect(shaped.findings).toEqual([
      {
        code: "credential-like-content",
        location: "hosted-composition",
        rule: "credential.openai-api-key",
      },
    ]);
  });

  /**
   * Runs the real `runHostedWorkflow` entry against a real Git workspace; other
   * turn tests drive `WorkflowRunner` directly and skip its turn wiring.
   */
  it("runs a hosted live-agent turn end to end and seals its answer", async () => {
    const { repository, state, revision, treeObjectId } = await turnGitFixture();
    const request = turnRequestFor(repository, state, revision, treeObjectId);

    const result = await runHostedWorkflow({ request, credential: null, emit: () => undefined });

    expect(result.record.status, JSON.stringify(result.record, null, 2)).toBe("succeeded");
    expect(result.record.workflow).toBe("live-agent-turn");
    expect(result.record.steps.map((step) => step.id)).toEqual(["answer-question"]);
    // The question reaches the model as a question, not the frozen JSON blob.
    expect(result.record.instruction).toContain("Does the guide say how to resume?");
    expect(result.record.instruction).not.toContain("[frozen-review-event]");
    // The hosted entry attaches the turn projection.
    const turn = result.record.liveAgentTurn;
    expect(turn?.sessionStateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(turn?.turnIndex).toBe(1);
    expect(turn?.answer).toBe("offline fixture executed answer-question");
    // The offline answer names no approved page, so the citation set is empty.
    // Citations are an intersection with the approved paths, not an
    // extraction from the prose.
    expect(turn?.citations).toEqual([]);
    expect(turn?.sessionState.exchanges).toHaveLength(1);
    expect(result.patch).toBeNull();

    // The runner binds the one named page as the step's context target, so the
    // preflight compiles against it and the unbound-target refusal applies,
    // instead of the `locate` policy's `target-not-applicable` shortcut.
    const preflight = result.record.steps[0]?.contextPreflight;
    expect(preflight?.status, JSON.stringify(preflight)).toBe("ready");
    expect(preflight?.reason).toBeUndefined();
    // A real compile, not the capsule echo the offline fixture would return
    // for an untargeted hosted step.
    expect(preflight?.packetDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(preflight?.packetDigest).not.toBe(request.capsule.sha256);
    expect(preflight?.ontologyVersion).not.toBe("hosted-v1");
    expect(preflight?.measurements?.nodeCount).toBeGreaterThan(0);

    const terminal = sealHostRuntimeTerminal({
      request,
      status: "succeeded",
      runtimeRecord: result.record,
      patch: result.patch,
    });
    expect(terminal.runRecord.binding.workflow).toBe("live-agent-turn");
    expect(
      (terminal.runRecord.runtimeRecord as { liveAgentTurn?: { sessionStateSha256: string } })
        .liveAgentTurn?.sessionStateSha256,
    ).toBe(turn?.sessionStateSha256);
  });

  it("records the activated project's retryableCategories on a hosted run", async () => {
    const { repository, state, revision, treeObjectId } = await turnGitFixture();
    const request = turnRequestFor(repository, state, revision, treeObjectId);
    const retryableCategories = ["malformed-response", "timeout"] as const;

    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit: () => undefined,
      environment: {
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_RETRY_BASE_DELAY_MS: "1",
        DOCSFAB_RETRY_MAX_DELAY_MS: "1",
        DOCSFAB_RETRYABLE_CATEGORIES: retryableCategories.join(","),
      },
    });

    expect(result.record.status, JSON.stringify(result.record, null, 2)).toBe("succeeded");
    expect(result.record.steps).toHaveLength(1);
    expect(result.record.steps[0]?.inference?.retryableCategories).toEqual([
      ...retryableCategories,
    ]);
    expect(result.record.steps[0]?.inference?.retryableCategories).not.toEqual([]);
    expect(result.record.steps[0]?.inference).toMatchObject({
      configuredMaxRetries: 1,
      effectiveMaxRetries: 1,
      replay: "read-only",
    });
  });

  it("runs a two-page turn with no context target, so the target refusal does not apply to it", async () => {
    // Documents current behaviour, not a settled decision. The hosted runner
    // binds a context target only when the frozen scope names exactly one
    // page, so a two-page turn takes the `locate` policy's no-target shortcut
    // (`unnecessary`, `target-not-applicable`) and still succeeds.
    const { repository, state, revision, treeObjectId } = await turnGitFixture();
    const request = turnRequestFor(repository, state, revision, treeObjectId, undefined, [
      "docs/guide.md",
      "README.md",
    ]);

    const result = await runHostedWorkflow({ request, credential: null, emit: () => undefined });

    expect(result.record.status, JSON.stringify(result.record, null, 2)).toBe("succeeded");
    expect(result.record.steps[0]?.contextPreflight).toEqual({
      status: "unnecessary",
      reason: "target-not-applicable",
    });
    expect(result.record.liveAgentTurn?.turnIndex).toBe(1);
    expect(result.record.liveAgentTurn?.sessionState.scopeSha256).toBe(
      request.packet.reviewScope?.scopeSha256,
    );
  });

  it.each(["workflow-execution", "terminal-sealing"] as const)(
    "discards arbitrary exception fields in a %s failure",
    (phase) => {
      const request = requestFor("/srv/work", "/srv/state", "a".repeat(40));
      const marker = "glpat-" + "h".repeat(40);
      const error = Object.assign(new Error(marker), {
        name: marker,
        code: marker,
        stack: marker,
        cause: { value: marker },
      });
      const record = buildHostRuntimeFailureRecord(request, error, phase);
      expect(record).toMatchObject({
        failurePhase: phase,
        code: phase === "workflow-execution" ? "execution-failed" : "terminal-sealing-failed",
      });
      expect(JSON.stringify(record)).not.toContain(marker);
      for (const field of ["usage", "providerCalls", "message", "stack", "cause"])
        expect(record).not.toHaveProperty(field);
      expect(
        sealHostRuntimeTerminal({ request, status: "failed", runtimeRecord: record, patch: null })
          .status,
      ).toBe("failed");
    },
  );

  it.each([
    ["workflow-execution", "turn-input-shape", "turn-input-shape"],
    ["workflow-execution", "run-store-write-failed", "execution-failed"],
    ["terminal-sealing", "credential-material", "credential-material"],
    ["workflow-execution", "credential-material", "execution-failed"],
    ["terminal-sealing", "run-store-write-failed", "terminal-sealing-failed"],
    ["terminal-sealing", "plausible-but-unrecognized", "terminal-sealing-failed"],
  ] as const)("restricts %s diagnostic code %s to its phase", (phase, code, expected) => {
    const request = requestFor("/srv/work", "/srv/state", "a".repeat(40));
    const record = buildHostRuntimeFailureRecord(request, { code }, phase);
    expect(record.code).toBe(expected);
    // The class is read from the sealed code, not the raw error.
    expect(record.failure).toEqual({
      class: HOSTED_RUNTIME_FAILURE_CODE_CLASSES[expected],
      layer: "workflow",
      code: expected,
    });
  });

  it("classes every hosted-runtime failure code (#1186)", () => {
    for (const [code, failureClass] of Object.entries(HOSTED_RUNTIME_FAILURE_CODE_CLASSES)) {
      expect(FAILURE_CLASSES, code).toContain(failureClass);
    }
    expect(HOSTED_RUNTIME_FAILURE_CODE_CLASSES["execution-failed"]).toBe("unknown");
    expect(HOSTED_RUNTIME_FAILURE_CODE_CLASSES["turn-input-shape"]).toBe("contract-shape");
  });

  it("admits only an actual runner boundary error with a recognized own storage code", () => {
    const request = requestFor("/srv/work", "/srv/state", "a".repeat(40));
    expect(
      buildHostRuntimeFailureRecord(
        request,
        new WorkflowRunnerBoundaryError("run-store-write-failed"),
      ).code,
    ).toBe("run-store-write-failed");
    const tampered = Object.assign(new WorkflowRunnerBoundaryError("run-store-write-failed"), {
      code: "run-store-sensitive-detail",
    });
    expect(buildHostRuntimeFailureRecord(request, tampered).code).toBe("execution-failed");
  });

  it.each(["workflow-execution", "terminal-sealing"] as const)(
    "seals %s failures without invoking hostile getters or trusting proxy traps",
    (phase) => {
      const request = requestFor("/srv/work", "/srv/state", "a".repeat(40));
      const trap = vi.fn(() => {
        throw new Error("sensitive-store-detail");
      });
      const getter = Object.defineProperty(
        new WorkflowRunnerBoundaryError("run-store-write-failed"),
        "code",
        { get: trap },
      );
      const descriptorProxy = new Proxy({}, { getOwnPropertyDescriptor: trap });
      const protoProxy = new Proxy({ code: "run-store-write-failed" }, { getPrototypeOf: trap });
      for (const error of [getter, descriptorProxy, protoProxy]) {
        const record = buildHostRuntimeFailureRecord(request, error, phase);
        expect(record.code).toBe(
          phase === "workflow-execution" ? "execution-failed" : "terminal-sealing-failed",
        );
        expect(
          sealHostRuntimeTerminal({ request, status: "failed", runtimeRecord: record, patch: null })
            .status,
        ).toBe("failed");
        expect(JSON.stringify(record)).not.toContain("sensitive-store-detail");
        if (error === getter) expect(trap).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "keeps terminal sealing and output-write failures separate (transport fails: %s)",
    async (transportFails) => {
      const request = requestFor("/srv/work", "/srv/state", "a".repeat(40));
      const record = buildHostRuntimeFailureRecord(request, new Error());
      // DocsFab's own configured credential refuses the seal; it looks like no
      // credential, so only the exact match can refuse that value. See #1807.
      const marker = plantConfiguredCredential();
      if (!transportFails) record.rejectedPayload = `Bearer ${marker}`;
      const outcome = {
        record: record as unknown as RunRecord,
        patch: null,
        patchEvidence: null,
        editorialOutcome: {
          state: "unavailable",
          outcome: "unavailable",
          decision: null,
          candidateReference: null,
          validatedReference: null,
          evidenceRefs: [],
          limitations: ["editorial-evidence-unavailable"],
        },
      } as Awaited<ReturnType<typeof runHostedWorkflow>>;
      const workflow = vi.spyOn(hostedWorkflow, "runHostedWorkflow").mockResolvedValue(outcome);
      const written: string[] = [];
      // Delivery is awaited, so the substitute calls back once the bytes are
      // accepted like the real descriptor. Returning only `true` would let a
      // worker claim a terminal the host never received.
      const output = vi.spyOn(process.stdout, "write").mockImplementation(((
        chunk: unknown,
        _encoding: unknown,
        callback: unknown,
      ) => {
        if (transportFails) throw new Error("test transport unavailable");
        written.push(String(chunk));
        if (typeof callback === "function") (callback as (error?: Error | null) => void)(null);
        return true;
      }) as never);
      const previousExitCode = process.exitCode;
      const signals = ["SIGTERM", "SIGINT"] as const;
      const previousListeners = new Map(
        signals.map((signal) => [signal, new Set(process.listeners(signal))]),
      );
      // A test worker may already own every fd in the host protocol's 3..16 range.
      // Fix the input descriptor/stream; production descriptor admission stays intact.
      const descriptor = vi.mocked(fstatSync).mockReturnValueOnce({ isFile: () => true } as Stats);
      let deliveredInput = false;
      const input = vi.mocked(read).mockImplementation((fd, callback) => {
        expect(fd).toBe(3);
        const buffer = deliveredInput ? Buffer.alloc(0) : Buffer.from(JSON.stringify(request));
        deliveredInput = true;
        queueMicrotask(() => callback(null, buffer.byteLength, buffer));
      });
      try {
        const run = hostInvokerMain(["--request-fd", "3"]);
        if (transportFails) await expect(run).rejects.toThrow("test transport unavailable");
        else {
          await run;
          expect(process.exitCode).toBe(1);
          // The body and its framing newline are separate writes, so a line
          // exactly at the supported carrier is not concatenated one unit past it.
          expect(written).toEqual([expect.any(String), "\n"]);
          const lines = written.join("").trim().split("\n").filter(Boolean);
          expect(lines).toHaveLength(1);
          const terminal = parseHostRuntimeTerminal(JSON.parse(lines[0]!), request);
          expect(terminal.runRecord.runtimeRecord).toMatchObject({
            failurePhase: "terminal-sealing",
            code: "credential-material",
            status: "failed",
          });
          expect(lines[0]).not.toContain(marker);
          expect(lines[0]).not.toContain("rejectedPayload");
        }
        // One write for a failed transport: the framing is not attempted after
        // the body was refused, and the refusal is what the run raises.
        expect(output).toHaveBeenCalledTimes(transportFails ? 1 : 2);
        expect(workflow).toHaveBeenCalledTimes(1);
      } finally {
        clearPlantedCredential();
        input.mockRestore();
        descriptor.mockRestore();
        output.mockRestore();
        workflow.mockRestore();
        process.exitCode = previousExitCode;
        for (const signal of signals)
          for (const listener of process.listeners(signal))
            if (!previousListeners.get(signal)!.has(listener))
              process.removeListener(signal, listener);
      }
    },
  );

  it("seals a refused turn so the operator sees the refusal code", async () => {
    // A turn carries a frozen scope, so the failure record must project it or
    // the seal throws `terminal-review-scope-substitution` and no terminal
    // line is written.
    const request = turnRequestFor("/srv/work", "/srv/state", "a".repeat(40), "b".repeat(40));
    const terminal = sealHostRuntimeTerminal({
      request,
      status: "failed",
      runtimeRecord: buildHostRuntimeFailureRecord(
        request,
        new LiveAgentTurnError("turn-scope-missing"),
      ),
      patch: null,
    });
    expect(terminal.status).toBe("failed");
    expect((terminal.runRecord.runtimeRecord as { code?: string }).code).toBe("turn-scope-missing");
  });

  /**
   * Executes `buildHostRuntimeFailureRecord` inside `hostInvokerMain`'s catch:
   * spawns the real entry point over a real file descriptor and reads the
   * single sealed terminal line it writes.
   */
  it.each(["direct", "symlink"])(
    "writes a sealed terminal naming the refusal when the %s entry point refuses a turn",
    async (entryMode) => {
      // A real workspace, because the turn is prepared after the runner asserts
      // the workspace revision; a scratch directory would fail earlier.
      const { repository, state, revision, treeObjectId, root } = await turnGitFixture();
      // Scope-bearing, but the review-event body is not JSON: the turn is
      // refused inside runHostedWorkflow, so the catch path is what seals.
      const request = turnRequestFor(repository, state, revision, treeObjectId, "not json at all");
      const requestPath = join(root, "request.json");
      await writeFile(requestPath, JSON.stringify(request));
      const sourceEntry = new URL("../src/host-invoker/main.ts", import.meta.url).pathname;
      const entry = entryMode === "symlink" ? join(root, "host-invoker-linked.ts") : sourceEntry;
      if (entryMode === "symlink") await symlink(sourceEntry, entry);

      const { stdout } = await new Promise<{ stdout: string; code: number | null }>(
        (resolve, reject) => {
          const requestFd = openSync(requestPath, "r");
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(process.execPath, ["--import", "tsx", entry, "--request-fd", "3"], {
              cwd: new URL("..", import.meta.url).pathname,
              stdio: ["ignore", "pipe", "pipe", requestFd],
            });
          } finally {
            closeSync(requestFd);
          }
          let out = "";
          let err = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            out += chunk.toString("utf8");
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            err += chunk.toString("utf8");
          });
          child.once("error", reject);
          child.once("close", (code) =>
            out.trim() === ""
              ? reject(new Error(`invoker wrote no terminal line; stderr: ${err.slice(0, 2000)}`))
              : resolve({ stdout: out, code }),
          );
        },
      );

      const lines = stdout.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const terminal = parseHostRuntimeTerminal(JSON.parse(lines[0]!), request);
      expect(terminal.status).toBe("failed");
      const runtimeRecord = terminal.runRecord.runtimeRecord as {
        code?: string;
        failurePhase?: HostRuntimeFailurePhase;
        reviewScope?: { scopeSha256?: string };
      };
      expect(runtimeRecord.code).toBe("turn-input-shape");
      expect(runtimeRecord.failurePhase).toBe("workflow-execution");
      expect(runtimeRecord.reviewScope?.scopeSha256).toBe(request.packet.reviewScope?.scopeSha256);
    },
    60_000,
  );

  it("stops at startup with public-roots-invalid when the declaration is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-invoker-public-roots-"));
    try {
      // The workspace does not exist: the run stops before it would be read.
      const request = requestFor(join(root, "missing"), join(root, "state"), "a".repeat(40));
      const requestPath = join(root, "request.json");
      await writeFile(requestPath, JSON.stringify(request));
      const entry = new URL("../src/host-invoker/main.ts", import.meta.url).pathname;
      const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>(
        (resolve, reject) => {
          const requestFd = openSync(requestPath, "r");
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(process.execPath, ["--import", "tsx", entry, "--request-fd", "3"], {
              cwd: new URL("..", import.meta.url).pathname,
              env: { ...process.env, DOCSFAB_PUBLIC_ROOTS: "/srv/private-root/" },
              stdio: ["ignore", "pipe", "ignore", requestFd],
            });
          } finally {
            closeSync(requestFd);
          }
          let out = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            out += chunk.toString("utf8");
          });
          child.once("error", reject);
          child.once("close", (exitCode) => resolve({ stdout: out, code: exitCode }));
        },
      );

      expect(code).toBe(1);
      const lines = stdout.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("private-root");
      const terminal = parseHostRuntimeTerminal(JSON.parse(lines[0]!), request);
      expect(terminal.status).toBe("failed");
      expect(terminal.runRecord.runtimeRecord).toMatchObject({
        failurePhase: "workflow-execution",
        code: "public-roots-invalid",
        failure: { class: "operator-input", code: "public-roots-invalid" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Scoped documentation patches through the hosted runtime. Cases build a real
 * Git repository, mint a grant against its tree, edit the workspace, and let
 * `recomputeHostedPatchEvidence` read the result from Git rather than from a
 * hand-written change list.
 */
describe("hosted scoped documentation write authority", () => {
  it("returns patch evidence and editorial outcome together for a granted installed workflow", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    const request = writeRequestFor(fixture, authority);
    const editorialOutcome = {
      state: "unavailable",
      outcome: "unavailable",
      decision: null,
      candidateReference: null,
      validatedReference: null,
      evidenceRefs: [],
      limitations: ["editorial-evidence-unavailable"],
    } as const;

    const { patch, evidence } = await recomputeHostedPatchEvidence({
      workspacePath: fixture.repository,
      authority,
    });
    const terminal = sealHostRuntimeTerminal({
      request,
      status: "succeeded",
      runtimeRecord: await runRecordFor(fixture, request),
      patch,
      patchEvidence: evidence,
      editorialOutcome,
    });
    expect(terminal.patchEvidence?.authoritySha256).toBe(authority.authoritySha256);
    expect(terminal.patchEvidence?.candidateTreeObjectId).toBe(fixture.treeObjectId);
    expect(terminal.patchEvidence?.changes).toEqual([]);
    expect(terminal.runRecord.editorialOutcome).toEqual(editorialOutcome);
  }, 60_000);

  it("binds a scoped patch to the granted path scope and candidate tree", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    const request = writeRequestFor(fixture, authority);

    await writeFile(join(fixture.repository, "docs", "guide.md"), "# Guide\n\nUpdated body.\n");
    await writeFile(join(fixture.repository, "docs", "new-page.md"), "# New page\n");
    await rm(join(fixture.repository, "docs", "retired.md"));

    const { patch, evidence } = await recomputeHostedPatchEvidence({
      workspacePath: fixture.repository,
      authority,
    });

    expect(patch).not.toBeNull();
    expect(evidence.authoritySha256).toBe(authority.authoritySha256);
    expect(evidence.sourceTreeObjectId).toBe(fixture.treeObjectId);
    // `T` is a real tree object, and it is not `H`.
    expect(evidence.candidateTreeObjectId).toMatch(/^[a-f0-9]{40}$/u);
    expect(evidence.candidateTreeObjectId).not.toBe(fixture.treeObjectId);
    expect(evidence.addedCount).toBe(1);
    expect(evidence.modifiedCount).toBe(1);
    expect(evidence.deletedCount).toBe(1);
    expect(evidence.changes.map((change) => `${change.operation} ${change.path}`)).toEqual([
      "modify docs/guide.md",
      "add docs/new-page.md",
      "delete docs/retired.md",
    ]);
    // The preimages are the blobs the host measured at `H`, not values the
    // evidence chose for itself.
    expect(
      evidence.changes.find((change) => change.path === "docs/guide.md")!.preimageObjectId,
    ).toBe(fixture.guideObjectId);
    expect(
      evidence.changes.find((change) => change.path === "docs/new-page.md")!.preimageObjectId,
    ).toBeNull();
    expect(evidence.patchSha256).toBe(createHash("sha256").update(patch!).digest("hex"));

    // The terminal admits the patch only because the grant covers it.
    const record = await runRecordFor(fixture, request);
    const terminal = sealHostRuntimeTerminal({
      request,
      status: "succeeded",
      runtimeRecord: record,
      patch,
      patchEvidence: evidence,
    });
    expect(terminal.patchEvidence?.candidateTreeObjectId).toBe(evidence.candidateTreeObjectId);
  });

  it("refuses a change outside the granted path scope", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    // `docs-internal/` is a sibling of the ceiling, not a child of it. A
    // prefix test without an explicit separator would admit it.
    await mkdir(join(fixture.repository, "docs-internal"), { recursive: true });
    await writeFile(join(fixture.repository, "docs-internal", "secret.md"), "# Escaped\n");

    await expect(
      recomputeHostedPatchEvidence({ workspacePath: fixture.repository, authority }),
    ).rejects.toThrowError("Hosted runtime rejected: patch-scope-escape.");
  });

  it("refuses a change to a path inside the ceiling the grant never measured", async () => {
    const fixture = await writeGitFixture();
    // A grant whose targets omit `docs/guide.md` entirely, though the ceiling
    // still covers `docs/`. Modifying it is then an unbound preimage.
    const authority = grantFor(fixture, {
      targets: [
        {
          path: "docs/retired.md",
          operations: ["modify", "delete"],
          preimageObjectId: fixture.retiredObjectId,
          fileMode: "100644",
        },
      ],
    });
    await writeFile(join(fixture.repository, "docs", "guide.md"), "# Guide\n\nUnbound edit.\n");

    await expect(
      recomputeHostedPatchEvidence({ workspacePath: fixture.repository, authority }),
    ).rejects.toThrowError("Hosted runtime rejected: patch-scope-escape.");
  });

  it("refuses a delete the grant did not authorize for that target", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture, {
      targets: [
        {
          path: "docs/guide.md",
          operations: ["modify"],
          preimageObjectId: fixture.guideObjectId,
          fileMode: "100644",
        },
      ],
    });
    await rm(join(fixture.repository, "docs", "guide.md"));

    await expect(
      recomputeHostedPatchEvidence({ workspacePath: fixture.repository, authority }),
    ).rejects.toThrowError("Hosted runtime rejected: patch-operation-mismatch.");
  });

  it("refuses a modify whose preimage is not the tree the grant was issued against", async () => {
    const fixture = await writeGitFixture();
    // A divergent preimage: the same path, a blob from a different file. The
    // grant is otherwise well formed, so only the preimage binding can reject it.
    const authority = grantFor(fixture, {
      targets: [
        {
          path: "docs/guide.md",
          operations: ["modify", "delete"],
          preimageObjectId: fixture.retiredObjectId,
          fileMode: "100644",
        },
      ],
    });
    await writeFile(join(fixture.repository, "docs", "guide.md"), "# Guide\n\nDivergent.\n");

    await expect(
      recomputeHostedPatchEvidence({ workspacePath: fixture.repository, authority }),
    ).rejects.toThrowError("Hosted runtime rejected: patch-preimage-mismatch.");
  });

  it("refuses a forbidden file mode inside the ceiling", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    // A symlink under the ceiling. Its content would read as documentation;
    // its mode is how it escapes.
    await symlink("/etc/passwd", join(fixture.repository, "docs", "link.md"));

    await expect(
      recomputeHostedPatchEvidence({ workspacePath: fixture.repository, authority }),
    ).rejects.toThrowError("Hosted runtime rejected: patch-forbidden-file-mode.");
  });

  it("refuses a change set past the grant's finite limit", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture, { maximumChangedPaths: 1 });
    await writeFile(join(fixture.repository, "docs", "a.md"), "# A\n");
    await writeFile(join(fixture.repository, "docs", "b.md"), "# B\n");

    await expect(
      recomputeHostedPatchEvidence({ workspacePath: fixture.repository, authority }),
    ).rejects.toThrowError("Hosted runtime rejected: patch-limit-exceeded.");
  });

  it("refuses a serialized boolean, a wrong version, and a tampered grant digest", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    const base = writeRequestBody(fixture, authority);

    // `allowWrite` and the grant must agree in both directions.
    expect(() =>
      parseHostRuntimeRequest({ ...base, allowWrite: true, writeAuthority: null }),
    ).toThrowError(expect.objectContaining({ code: "write-authority-required" }));
    expect(() =>
      parseHostRuntimeRequest({ ...base, allowWrite: false, writeAuthority: authority }),
    ).toThrowError(expect.objectContaining({ code: "write-authority-required" }));

    // A v1-shaped grant is not a grant. The version is part of the binding.
    expect(() =>
      parseHostRuntimeRequest({
        ...base,
        writeAuthority: { ...authority, schemaVersion: 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "write-authority-version" }));

    // A self-consistent-looking body with a stale digest: widening the ceiling
    // after sealing does not re-mint the grant.
    expect(() =>
      parseHostRuntimeRequest({
        ...base,
        writeAuthority: { ...authority, pathCeiling: ["docs/", "packages/runtime/docs/"] },
      }),
    ).toThrowError(expect.objectContaining({ code: "write-authority-digest-mismatch" }));

    // Re-sealing a changed body mints a different digest.
    const widened = sealHostRuntimeWriteAuthority({
      ...authorityBody(authority),
      targets: [
        {
          path: "docs/guide.md",
          operations: ["modify", "delete"],
          preimageObjectId: fixture.guideObjectId,
          fileMode: "100644",
        },
      ],
    });
    expect(widened.authoritySha256).not.toBe(authority.authoritySha256);
  });

  it("refuses a grant bound to another run, tree, or composition", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    const request = writeRequestFor(fixture, authority);

    // Every field the binding checks gets its own divergent fixture, so
    // dropping any single clause fails.
    for (const [label, divergent] of [
      ["deploymentId", { deploymentId: "deployment-other" }],
      ["projectId", { projectId: "project-other" }],
      ["deploymentEpoch", { deploymentEpoch: "epoch-other" }],
      ["requestKey", { requestKey: "request-other" }],
      ["runId", { runId: "run-other" }],
      ["fence", { fence: 2 }],
      ["workflow", { workflow: "create-documentation" as const }],
      ["sourceRevision", { sourceRevision: "9".repeat(40) }],
      ["sourceTreeObjectId", { sourceTreeObjectId: "f".repeat(40) }],
      ["capsuleSha256", { capsuleSha256: "a".repeat(64) }],
      ["compositionSha256", { compositionSha256: "c".repeat(64) }],
      ["toolPolicySha256", { toolPolicySha256: "b".repeat(64) }],
    ] as const) {
      const substituted = sealHostRuntimeWriteAuthority({
        ...authorityBody(authority),
        ...divergent,
      });
      expect(
        () => assertHostRuntimeWriteAuthorityBinding({ authority: substituted, request }),
        `a grant carrying a divergent ${label} must not bind`,
      ).toThrowError(expect.objectContaining({ code: "write-authority-binding-mismatch" }));
    }

    // Expiry is a binding too: a grant that has run out cannot be replayed.
    const expired = sealHostRuntimeWriteAuthority({
      ...authorityBody(authority),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(() =>
      assertHostRuntimeWriteAuthorityBinding({ authority: expired, request }),
    ).toThrowError(expect.objectContaining({ code: "write-authority-expired" }));

    // And a grant naming a write step this release's workflow does not have is
    // refused against the installed catalog, not against the request.
    expect(() =>
      assertHostRuntimeWriteAuthorityBinding({
        authority,
        request,
        installedWriteStepIds: ["some-other-write-step"],
      }),
    ).toThrowError(expect.objectContaining({ code: "write-authority-step-substitution" }));
  });

  it("refuses a terminal whose patch evidence is missing, mismatched, or unauthorized", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    const request = writeRequestFor(fixture, authority);
    await writeFile(join(fixture.repository, "docs", "guide.md"), "# Guide\n\nUpdated.\n");
    const { patch, evidence } = await recomputeHostedPatchEvidence({
      workspacePath: fixture.repository,
      authority,
    });
    const record = await runRecordFor(fixture, request);

    // A succeeded write run must always account for what it changed.
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: record,
        patch,
        patchEvidence: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-patch-evidence-missing" }));

    // Evidence from a different grant does not bind, even though it is itself
    // internally valid.
    const otherGrant = grantFor(fixture, { runId: "run-other-write" });
    const otherEvidence = sealHostRuntimePatchEvidence({
      authority: otherGrant,
      candidateTreeObjectId: evidence.candidateTreeObjectId,
      changes: [...evidence.changes],
      patch,
    });
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: record,
        patch,
        patchEvidence: otherEvidence,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-write-authority-mismatch" }));

    // A patch body swapped under honest evidence is a digest mismatch.
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: record,
        patch: `${patch}\n# appended\n`,
        patchEvidence: evidence,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal-patch-digest-mismatch" }));

    // And a read-only request still cannot carry either one.
    const readOnly = requestFor(
      fixture.repository,
      fixture.state,
      fixture.revision,
      fixture.treeObjectId,
    );
    expect(readOnly.allowWrite).toBe(false);
    expect(readOnly.writeAuthority).toBeNull();
    expect(() =>
      parseHostRuntimeTerminal(
        {
          schemaVersion: 1,
          kind: "docsfab-host-runtime-terminal",
          status: "succeeded",
          runRecord: {
            ...sealHostRuntimeTerminal({
              request,
              status: "succeeded",
              runtimeRecord: record,
              patch,
              patchEvidence: evidence,
            }).runRecord,
          },
          patch: null,
          patchEvidence: evidence,
        },
        readOnly,
      ),
    ).toThrowError(expect.objectContaining({ code: "terminal-patch-not-authorized" }));
  });

  it("supports a separately bound read-only invocation over the same source tree", async () => {
    const fixture = await writeGitFixture();
    const authority = grantFor(fixture);
    // Same `H`, same workspace, no grant: the read-only request is its own
    // binding and it never sees the candidate tree.
    const readOnly = requestFor(
      fixture.repository,
      fixture.state,
      fixture.revision,
      fixture.treeObjectId,
    );
    expect(readOnly.writeAuthority).toBeNull();
    expect(readOnly.allowWrite).toBe(false);
    expect(readOnly.sourceTreeObjectId).toBe(authority.sourceTreeObjectId);

    // It runs against the clean base tree and produces no patch.
    const result = await runHostedWorkflow({
      request: readOnly,
      credential: null,
      emit: () => undefined,
    });
    expect(result.record.status, JSON.stringify(result.record)).toBe("succeeded");
    expect(result.patch).toBeNull();
    expect(result.patchEvidence).toBeNull();
    // `H` is unchanged.
    const after = (
      await exec("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: fixture.repository,
        encoding: "utf8",
      })
    ).stdout.trim();
    expect(after).toBe(fixture.treeObjectId);
  }, 60_000);

  it("refuses to run an installed write workflow with no grant at all", async () => {
    const fixture = await writeGitFixture();
    const workflow = getWorkflow("update-documentation");
    const stepIds = workflow.steps.map((step) => step.id);
    const declaredTools = [
      ...new Set(workflow.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search))),
    ].sort();
    const composition = sealHostRuntimeComposition({
      compositionId: "offline-update-v1",
      route: "offline-fixture",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools,
    });
    const request = parseHostRuntimeRequest({
      ...writeRequestBody(fixture, null),
      workflow: "update-documentation",
      stepIds,
      toolPolicySha256: digest({ workflow: "update-documentation", stepIds, declaredTools }),
      composition,
      allowWrite: false,
      writeAuthority: null,
    });
    await expect(
      runHostedWorkflow({ request, credential: null, emit: () => undefined }),
    ).rejects.toThrowError(
      "Hosted write workflows require a separate operation-specific write grant.",
    );
  });
});

const WRITE_CEILING = ["docs/"];

/** A repository with tracked documentation the grant can bind preimages to. */
async function writeGitFixture(): Promise<{
  root: string;
  repository: string;
  state: string;
  revision: string;
  treeObjectId: string;
  guideObjectId: string;
  retiredObjectId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-host-write-"));
  roots.push(root);
  const repository = join(root, "repository");
  const state = join(root, "state");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "README.md"), "# Exact fixture\n");
  await writeFile(join(repository, "docs", "guide.md"), "# Guide\n\nBounded source.\n");
  await writeFile(join(repository, "docs", "retired.md"), "# Retired\n");
  await exec("git", ["init", "-q"], { cwd: repository });
  await exec("git", ["config", "user.name", "DocsFab Test"], { cwd: repository });
  await exec("git", ["config", "user.email", "docsfab-test@example.invalid"], { cwd: repository });
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const revision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })
  ).stdout.trim();
  const treeObjectId = (
    await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" })
  ).stdout.trim();
  const objectId = async (path: string): Promise<string> =>
    (
      await exec("git", ["rev-parse", `HEAD:${path}`], { cwd: repository, encoding: "utf8" })
    ).stdout.trim();
  return {
    root,
    repository,
    state,
    revision,
    treeObjectId,
    guideObjectId: await objectId("docs/guide.md"),
    retiredObjectId: await objectId("docs/retired.md"),
  };
}

/** The body of a sealed grant, so a test can re-seal one divergent field. */
function authorityBody(authority: HostRuntimeWriteAuthorityV2) {
  const { authoritySha256: _digest, ...body } = authority;
  return body;
}

/** A host-shaped grant over the fixture's real tree and real preimages. */
function grantFor(
  fixture: Awaited<ReturnType<typeof writeGitFixture>>,
  options: {
    targets?: HostRuntimeWriteAuthorityV2["targets"];
    maximumChangedPaths?: number;
    runId?: string;
  } = {},
): HostRuntimeWriteAuthorityV2 {
  return sealHostRuntimeWriteAuthority({
    schemaVersion: 2,
    kind: "docsfab-host-runtime-write-authority",
    deploymentId: "deployment-test",
    projectId: "project-test",
    deploymentEpoch: "epoch-test",
    requestKey: "request-test",
    runId: options.runId ?? "run-exact-fixture",
    fence: 1,
    workflow: "update-documentation",
    sourceRevision: fixture.revision,
    sourceTreeObjectId: fixture.treeObjectId,
    pathCeiling: WRITE_CEILING,
    targets: options.targets ?? [
      {
        path: "docs/guide.md",
        operations: ["modify", "delete"],
        preimageObjectId: fixture.guideObjectId,
        fileMode: "100644",
      },
      {
        path: "docs/retired.md",
        operations: ["modify", "delete"],
        preimageObjectId: fixture.retiredObjectId,
        fileMode: "100644",
      },
    ],
    writeStepIds: ["write-documentation"],
    capsuleSha256: capsule([]).sha256,
    compositionSha256: writeComposition().compositionSha256,
    toolPolicySha256: writeToolPolicySha256(),
    expiresAt: "2099-01-01T00:00:00.000Z",
    limits: {
      maximumChangedPaths: options.maximumChangedPaths ?? 16,
      maximumPatchBytes: 1024 * 1024,
    },
  });
}

function writeComposition() {
  return sealHostRuntimeComposition({
    compositionId: "offline-update-v1",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools: [
      ...new Set(
        getWorkflow("update-documentation").steps.flatMap((step) =>
          grantedTools(step.mode, step.kind, step.search),
        ),
      ),
    ].sort(),
  });
}

function writeToolPolicySha256(): string {
  const workflow = getWorkflow("update-documentation");
  return digest({
    workflow: "update-documentation",
    stepIds: workflow.steps.map((step) => step.id),
    declaredTools: writeComposition().declaredTools,
  });
}

function writeRequestBody(
  fixture: Awaited<ReturnType<typeof writeGitFixture>>,
  authority: HostRuntimeWriteAuthorityV2 | null,
): Record<string, unknown> {
  const workflow = getWorkflow("update-documentation");
  const content = '{"schemaVersion":1,"kind":"fixture-input"}\n';
  return {
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "deployment-test",
    projectId: "project-test",
    deploymentEpoch: "epoch-test",
    requestKey: "request-test",
    origin: { principalId: "principal-test", requestId: "request-origin" },
    runId: "run-exact-fixture",
    fence: 1,
    workflow: "update-documentation",
    revision: fixture.revision,
    sourceTreeObjectId: fixture.treeObjectId,
    packet: {
      packetFingerprintSha256: "e".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: createHash("sha256").update(content).digest("hex"),
        sourcePathSha256: createHash("sha256").update("docs/input.json").digest("hex"),
        gitObjectId: "b".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
    },
    stepIds: workflow.steps.map((step) => step.id),
    toolPolicySha256: writeToolPolicySha256(),
    workspacePath: fixture.repository,
    stateDirectory: fixture.state,
    capsule: capsule([]),
    composition: writeComposition(),
    allowWrite: authority !== null,
    writeAuthority: authority,
  };
}

function writeRequestFor(
  fixture: Awaited<ReturnType<typeof writeGitFixture>>,
  authority: HostRuntimeWriteAuthorityV2,
): HostRuntimeRequestV1 {
  return parseHostRuntimeRequest(writeRequestBody(fixture, authority));
}

/**
 * A run record built from the request's own step catalog and declared tools, so
 * a terminal assertion fails for the reason it names rather than record shape.
 */
async function runRecordFor(
  fixture: Awaited<ReturnType<typeof writeGitFixture>>,
  request: HostRuntimeRequestV1,
): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    id: request.runId,
    workflow: request.workflow,
    repository: { revision: fixture.revision },
    status: "succeeded",
    steps: request.stepIds.map((id) => ({ id })),
    tools: {
      totalCalls: 0,
      failedCalls: 0,
      byTool: request.composition.declaredTools.map((name) => ({ name, calls: 0, failures: 0 })),
      failureCategories: [],
    },
    models: [
      {
        provider: "offline-fixture",
        model: request.composition.compositionSha256.slice(0, 16),
      },
    ],
    securityScan: { findings: [] },
  };
}

function declaredToolsFor(workflowId: "readiness" | "review-documentation"): string[] {
  return [
    ...new Set(
      getWorkflow(workflowId).steps.flatMap((step) =>
        grantedTools(step.mode, step.kind, step.search),
      ),
    ),
  ].sort();
}

/** A host-shaped focused scope: canonical body, self-digest, host-bound count. */
function sealedScope(body: {
  targets: { path: string; reason: string }[];
  deferred: { path: string; reason: string }[];
  corpusFileCount: number;
}) {
  const canonical = {
    schemaVersion: 1,
    kind: "docsfab-review-scope",
    scope: "focused-set",
    reason: "operator-named",
    targets: body.targets,
    deferred: body.deferred,
  };
  return {
    ...canonical,
    scopeSha256: createHash("sha256").update(canonicalJson(canonical)).digest("hex"),
    corpusFileCount: body.corpusFileCount,
  };
}

/** A committed one-revision repository the hosted runner will accept. */
async function turnGitFixture(): Promise<{
  root: string;
  repository: string;
  state: string;
  revision: string;
  treeObjectId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-live-agent-turn-"));
  roots.push(root);
  const repository = join(root, "repository");
  const state = join(root, "state");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "README.md"), "# Exact fixture\n");
  await writeFile(join(repository, "docs", "guide.md"), "# Guide\n\nResume with --new.\n");
  await exec("git", ["init", "-q"], { cwd: repository });
  await exec("git", ["config", "user.name", "DocsFab Test"], { cwd: repository });
  await exec("git", ["config", "user.email", "docsfab-test@example.invalid"], { cwd: repository });
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const revision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })
  ).stdout.trim();
  const treeObjectId = (
    await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" })
  ).stdout.trim();
  return { root, repository, state, revision, treeObjectId };
}

function turnRequestFor(
  workspacePath: string,
  stateDirectory: string,
  revision: string,
  sourceTreeObjectId: string,
  rawTurnBody?: string,
  targetPaths: readonly string[] = ["docs/guide.md"],
): HostRuntimeRequestV1 {
  const stepIds = ["answer-question"];
  // The hosted runner carries `corpusFileCount` from the request and the
  // terminal re-asserts equality with it; the fixture repository has exactly
  // two tracked Markdown files, so the value is true of the workspace too.
  const reviewScope = sealedScope({
    targets: targetPaths.map((path) => ({ path, reason: "operator-named" })),
    deferred: [],
    corpusFileCount: 2,
  });
  const content =
    rawTurnBody ??
    canonicalTurnBody({
      turnKind: "docsfab-live-agent-turn",
      sessionId: "session-e2e",
      threadBindingSha256: "c".repeat(64),
      messageTs: "1757606400.000200",
      text: "Does the guide say how to resume?",
      scopeSha256: reviewScope.scopeSha256,
      priorSessionStateSha256: null,
      priorSessionState: null,
    });
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "deployment-test",
    projectId: "project-test",
    deploymentEpoch: "epoch-test",
    requestKey: "slack:turn:e2e",
    origin: { principalId: "principal-test", requestId: "request-origin" },
    runId: "run-live-agent-turn",
    fence: 1,
    workflow: "live-agent-turn",
    revision,
    sourceTreeObjectId,
    packet: {
      packetFingerprintSha256: "e".repeat(64),
      inputManifest: null,
      canon: null,
      reviewEvent: {
        kind: "review-event",
        sha256: createHash("sha256").update(content).digest("hex"),
        content,
      },
      reviewScope,
    },
    stepIds,
    toolPolicySha256: digest({ workflow: "live-agent-turn", stepIds, declaredTools: tools }),
    workspacePath,
    stateDirectory,
    capsule: capsule([]),
    composition: sealHostRuntimeComposition({
      compositionId: "offline-v1",
      route: "offline-fixture",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools: tools,
    }),
    allowWrite: false,
  });
}

/** Key-sorted JSON, matching the host's canonical frozen-event encoding. */
function canonicalTurnBody(body: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
}

function verifiedNoChangeOutcome(revision: string) {
  const candidateReference = {
    kind: "editorial-decision" as const,
    schemaVersion: 3 as const,
    digest: "1".repeat(64),
    repositoryRevision: revision,
    repositoryContentDigest: "2".repeat(64),
  };
  const validatedReference = { ...candidateReference, digest: "3".repeat(64) };
  const evidenceReference = {
    kind: "context-packet" as const,
    schemaVersion: 1 as const,
    digest: "4".repeat(64),
    repositoryRevision: revision,
    repositoryContentDigest: candidateReference.repositoryContentDigest,
  };
  return {
    state: "validated" as const,
    outcome: "verified-no-change" as const,
    decision: "no-change" as const,
    candidateReference,
    validatedReference,
    evidenceRefs: [evidenceReference],
    limitations: ["audience-evidence-unavailable"],
  };
}

async function candidateSourceFixture(before: string | Buffer, after: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-candidate-source-evidence-"));
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(join(repository, "docs"), { recursive: true });
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "docs", "guide.md"), "# Source guide\n");
  await writeFile(join(repository, "src", "feature.ts"), before);
  await exec("git", ["init", "-q"], { cwd: repository });
  await exec("git", ["config", "user.name", "DocsFab Test"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-qm", "base source"], { cwd: repository });
  const sourceBaseRevision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  await writeFile(join(repository, "src", "feature.ts"), after);
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-qm", "source change"], { cwd: repository });
  const sourceHeadRevision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  const sourceHeadTreeObjectId = (
    await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })
  ).stdout.trim();
  const preimageObjectId = (
    await exec("git", ["rev-parse", "HEAD:docs/guide.md"], { cwd: repository })
  ).stdout.trim();
  await writeFile(join(repository, "docs", "guide.md"), "# Candidate guide\n");
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-qm", "candidate"], { cwd: repository });
  const reviewCommitObjectId = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  const candidateTreeObjectId = (
    await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })
  ).stdout.trim();
  const scope = sealedScope({
    targets: [{ path: "docs/guide.md", reason: "operator-named" }],
    deferred: [],
    corpusFileCount: 1,
  });
  const base = requestFor(
    repository,
    join(root, "state"),
    reviewCommitObjectId,
    candidateTreeObjectId,
    { workflow: "review-documentation", reviewScope: scope },
  );
  const candidateBody = {
    schemaVersion: 1,
    kind: "docsfab-candidate-review-binding",
    requestKey: base.requestKey,
    sourceBaseRevision,
    sourceHeadRevision,
    sourceHeadTreeObjectId,
    sourceManifestSha256: digest([
      { path: "src/feature.ts", status: "modified", previousPath: null },
    ]),
    sourceImpactSha256: "2".repeat(64),
    targetManifestSha256: "3".repeat(64),
    targets: [{ path: "docs/guide.md", operations: ["modify"], preimageObjectId }],
    candidateTreeObjectId,
    reviewCommitObjectId,
    patchSha256: "4".repeat(64),
    policySha256: "5".repeat(64),
    contextAuthoritySha256: "6".repeat(64),
    authorRunRecordSha256: "7".repeat(64),
    authorDispatcherReceiptSha256: "8".repeat(64),
    authorExecutionIdentitySha256: "9".repeat(64),
    authorSessionSha256: "a".repeat(64),
    reviewerSessionSha256: "b".repeat(64),
    requestIdentitySha256: digest({
      requestKey: base.requestKey,
      mappedIdentity: base.origin.principalId,
      requestId: base.origin.requestId,
    }),
  };
  const request = parseHostRuntimeRequest({
    ...base,
    packet: {
      packetFingerprintSha256: base.packet.packetFingerprintSha256,
      inputManifest: null,
      canon: null,
      reviewEvent: null,
      reviewScope: scope,
      candidateReview: { ...candidateBody, bindingSha256: digest(candidateBody) },
    },
  });
  return { request, candidateBody };
}

function requestFor(
  workspacePath: string,
  stateDirectory: string,
  revision: string,
  sourceTreeObjectId = "a".repeat(40),
  options: {
    workflow?: "readiness" | "review-documentation";
    reviewScope?: ReturnType<typeof sealedScope>;
  } = {},
): HostRuntimeRequestV1 {
  const workflow = options.workflow ?? "readiness";
  const stepIds = getWorkflow(workflow).steps.map((step) => step.id);
  const declaredTools = declaredToolsFor(workflow);
  const content = '{"schemaVersion":1,"kind":"fixture-input"}\n';
  const sha256 = createHash("sha256").update(content).digest("hex");
  const composition = sealHostRuntimeComposition({
    compositionId: "offline-v1",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools,
  });
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "deployment-test",
    projectId: "project-test",
    deploymentEpoch: "epoch-test",
    requestKey: "request-test",
    origin: { principalId: "principal-test", requestId: "request-origin" },
    runId: "run-exact-fixture",
    fence: 1,
    workflow,
    revision,
    sourceTreeObjectId,
    packet: {
      packetFingerprintSha256: "e".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256,
        sourcePathSha256: createHash("sha256").update("docs/input.json").digest("hex"),
        gitObjectId: "b".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
      ...(options.reviewScope ? { reviewScope: options.reviewScope } : {}),
    },
    stepIds,
    toolPolicySha256: digest({ workflow, stepIds, declaredTools }),
    workspacePath,
    stateDirectory,
    capsule: capsule([{ evidenceId: "product-model", content: "Approved product context." }]),
    composition,
    allowWrite: false,
  });
}

function capsule(selectedEvidence: readonly { evidenceId: string; content: string }[]) {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const receiptSha256 = "d".repeat(64);
  return {
    sha256: digest({ receiptSha256, expiresAt, selectedEvidence }),
    receiptSha256,
    expiresAt,
    selectedEvidence,
  };
}

function executionProfile(
  routeId: "openai-direct" | "anthropic-direct" | "nvidia-api-catalog" | "nvidia-inference-api",
  transport: "openai-chat-completions" | "anthropic-messages",
  apiFormat: "chat_completions" | "messages",
) {
  return {
    routeId,
    providerId: routeId,
    baseUrl: "https://example.invalid/v1",
    modelId: "model-fixture",
    transport,
    apiFormat,
    profile: {
      configuredLimits: { contextWindow: 8192, maxInputTokens: 4096, maxOutputTokens: 2048 },
      contextWindow: 8192,
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      effectiveLimitReason: "composition-candidate" as const,
      reasoning: false,
      input: ["text" as const],
      compatibility: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        apiFormats: [apiFormat],
      },
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      metadata: {
        approvedSource: null,
        effectiveDate: null,
        reviewAfter: null,
        status: "unknown" as const,
      },
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 512 },
    compositionPolicy: { maxProviderTurns: 4, timeoutMs: 30_000, maxResponseBytes: 1_048_576 },
  };
}
