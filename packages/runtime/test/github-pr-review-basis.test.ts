// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import * as filesystem from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { limit } from "../src/config/limits.js";
import { sourceExtractionMaxOriginalBytes } from "../src/config/source-read-limits.js";
import {
  assertGithubPrBaseDocumentationDescriptor,
  assertGithubPrReviewBasis,
  assertGithubPrObjectAcquisition,
  withGithubPrReviewBasis,
} from "../src/inputs/adapters/github-pr-provider.js";
import {
  createGithubPrCustody,
  createGithubPrHOriginalRepresentation,
  type GithubPrHSourceHostContext,
  type GithubPrHSourceObservations,
  type GithubPrHSourcePrivateHandlers,
} from "../src/inputs/local/github-pr-custody.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { workspaceIdentityDigest } from "../src/cli/run/source-acquisition.js";
import { admitWorkflowRunRequest } from "../src/workflow-execution/runner-admission.js";
import type { WorkflowRunnerOptions } from "../src/workflow-execution/runner-ports.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import type { RunRequest } from "../src/execution/contracts.js";
import {
  listExternalInputAccessObservations,
  registerTrackedRepositorySourceInput,
  recordExternalInputAccess,
} from "../src/inputs/access.js";
import { citeExternalInput, createExternalInputCitationLedger } from "../src/inputs/citation.js";
import {
  computeSourceRepresentationId,
  computeSourceSpanId,
  createSourceObservation,
  createSourceRepresentation,
  projectSourceRequestContext,
} from "../src/inputs/source-evidence.js";
import {
  computeAcquisitionReceiptSha256,
  computeSourceInputId,
  computeSourceObservationId,
  computeSourceOriginId,
  digestSourceReadScope,
  TRACKED_SOURCE_PRODUCER_ID,
  TRACKED_SOURCE_PRODUCER_VERSION,
  trackedSourceCanonicalLocator,
} from "../src/inputs/source-acquisition.js";
import {
  classifySourceMediaType,
  createDefaultSourceExtractorRegistry,
} from "../src/inputs/source-extractor-registry.js";
import { extractSourceRepresentation, sha256Bytes } from "../src/inputs/source-extraction.js";
import {
  assertGithubPrVerifiedTreeExportPort,
  createGithubPrObjectReader,
  type GithubPrVerifiedTreeExportPort,
} from "../src/inputs/adapters/github-pr-objects.js";
import { createSourceStepPolicy } from "../src/inputs/source-step-policy.js";
import { acquireRepositoryWorkspaceLease } from "../src/repository/workspace/lease.js";
import { prepareRepositoryWorkspaceFromVerifiedTree } from "../src/repository/workspace/materialize.js";
import {
  assertActiveRepositoryWorkspace,
  closeScopedRepositoryWorkspace,
  listTrackedRepositoryEntries,
  readTrackedRepositoryFile,
  waitForScopedRepositoryWorkspaceCleanup,
} from "../src/repository/workspace/tracked-read.js";
import * as trackedWorkspaceReads from "../src/repository/workspace/tracked-read.js";
import * as repositoryInventory from "../src/repository/inventory.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const scopedRemovalFault = vi.hoisted(() => ({ root: "", injected: false }));
const scopedRemovalDelay = vi.hoisted(() => ({
  root: "",
  active: false,
  entered: (() => undefined) as () => void,
  release: Promise.resolve(),
}));
const workspaceProgress = vi.hoisted(() => ({
  active: false,
  exportStarted: false,
  partialBytes: 0,
  writes: 0,
  advance: (() => undefined) as () => void,
  pauseAfterWrites: 0,
  advanceGitChunks: false,
  gitChunks: 0,
  holdFirstWrite: false,
  writeEntered: (() => undefined) as () => void,
  releaseWrite: Promise.resolve(),
}));
const workspaceLstatGate = vi.hoisted(() => ({
  active: false,
  fail: false,
  entered: (() => undefined) as () => void,
  release: Promise.resolve(),
}));
const workspaceSetupGate = vi.hoisted(() => ({
  phase: "" as "" | "mkdtemp" | "mkdir",
  advance: (() => undefined) as () => void,
}));
const workspaceFinalReadGate = vi.hoisted(() => ({
  phase: "" as "" | "lstat" | "realpath",
  entered: (() => undefined) as () => void,
  release: Promise.resolve(),
}));
const custodyReadCloseGate = vi.hoisted(() => ({
  active: false,
  path: "",
  observedPaths: [] as string[],
  opens: 0,
  entered: (() => undefined) as () => void,
  release: Promise.resolve(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (
        workspaceProgress.active &&
        workspaceProgress.exportStarted &&
        workspaceProgress.advanceGitChunks &&
        args[0] === "git" &&
        Array.isArray(args[1]) &&
        args[1].includes("cat-file")
      ) {
        // Observe genuine child output before the production data listener resets the stall clock.
        child.stdout?.on("data", () => {
          workspaceProgress.gitChunks += 1;
          workspaceProgress.advance();
        });
      }
      return child;
    }) as typeof actual.spawn,
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const result = await actual.mkdtemp(...args);
      if (
        workspaceSetupGate.phase === "mkdtemp" &&
        String(args[0]).endsWith("docsfab-github-head-")
      ) {
        workspaceSetupGate.phase = "";
        workspaceSetupGate.advance();
      }
      return result;
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      if (
        workspaceProgress.active &&
        /docsfab-github-head-[^/]+\/repository$/u.test(String(args[0]))
      ) {
        workspaceProgress.exportStarted = true;
      }
      if (
        workspaceSetupGate.phase === "mkdir" &&
        /docsfab-github-head-[^/]+\/repository$/u.test(String(args[0]))
      ) {
        workspaceSetupGate.phase = "";
        workspaceSetupGate.advance();
      }
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (custodyReadCloseGate.active && String(args[0]).endsWith("/docs/unchanged.md"))
        custodyReadCloseGate.observedPaths.push(String(args[0]));
      if (custodyReadCloseGate.active && String(args[0]) === custodyReadCloseGate.path) {
        custodyReadCloseGate.opens += 1;
        if (custodyReadCloseGate.opens === 2) {
          const originalClose = handle.close.bind(handle);
          const release = custodyReadCloseGate.release;
          Object.defineProperty(handle, "close", {
            configurable: true,
            value: async () => {
              custodyReadCloseGate.entered();
              await release;
              return originalClose();
            },
          });
        }
      }
      if (
        workspaceProgress.active &&
        /docsfab-github-head-[^/]+\/repository\/docs\/unchanged\.md$/u.test(String(args[0]))
      ) {
        const originalWrite = handle.write.bind(handle);
        Object.defineProperty(handle, "write", {
          configurable: true,
          value: async (bytes: Buffer, offset: number, length: number, position: number) => {
            if (workspaceProgress.holdFirstWrite) {
              workspaceProgress.holdFirstWrite = false;
              workspaceProgress.writeEntered();
              await workspaceProgress.releaseWrite;
            }
            const result = await originalWrite(
              bytes,
              offset,
              workspaceProgress.partialBytes > 0
                ? Math.min(length, workspaceProgress.partialBytes)
                : length,
              position,
            );
            workspaceProgress.writes += 1;
            workspaceProgress.advance();
            if (workspaceProgress.writes === workspaceProgress.pauseAfterWrites) {
              workspaceProgress.writeEntered();
              await workspaceProgress.releaseWrite;
            }
            return result;
          },
        });
      }
      return handle;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      if (
        workspaceFinalReadGate.phase === "lstat" &&
        /docsfab-github-head-[^/]+\/repository$/u.test(path)
      ) {
        workspaceFinalReadGate.phase = "";
        workspaceFinalReadGate.entered();
        await workspaceFinalReadGate.release;
      }
      if (workspaceLstatGate.active && /docsfab-github-head-[^/]+\/repository$/u.test(path)) {
        workspaceLstatGate.active = false;
        workspaceLstatGate.entered();
        await workspaceLstatGate.release;
        if (workspaceLstatGate.fail) {
          scopedRemovalFault.root = path.slice(0, path.lastIndexOf("/"));
          throw new Error("controlled-export-verification-failure");
        }
      }
      return actual.lstat(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = String(args[0]);
      if (
        workspaceFinalReadGate.phase === "realpath" &&
        /docsfab-github-head-[^/]+\/repository$/u.test(path)
      ) {
        workspaceFinalReadGate.phase = "";
        workspaceFinalReadGate.entered();
        await workspaceFinalReadGate.release;
      }
      return actual.realpath(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (scopedRemovalDelay.active && String(args[0]) === scopedRemovalDelay.root) {
        scopedRemovalDelay.active = false;
        scopedRemovalDelay.entered();
        await scopedRemovalDelay.release;
      }
      if (
        scopedRemovalFault.root !== "" &&
        String(args[0]) === scopedRemovalFault.root &&
        !scopedRemovalFault.injected
      ) {
        scopedRemovalFault.injected = true;
        throw new Error("controlled-workspace-remove-failure");
      }
      return actual.rm(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function gitEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "file",
    LANG: "C",
    LC_ALL: "C",
  };
}

function git(root: string, cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(root),
  }).trim();
}

async function nativeFixture(
  codeOnly = false,
  colliding = false,
  emptyHead = false,
  excludedSpecial = false,
  extraHeadDocs = 0,
  exactHSource = false,
) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-github-basis-"));
  roots.push(root);
  const work = join(root, "work");
  const scratch = join(root, "scratch");
  await mkdir(work);
  await mkdir(scratch);
  git(root, work, "init", "-q");
  git(root, work, "config", "user.name", "Fixture");
  git(root, work, "config", "user.email", "fixture@example.invalid");
  if (colliding) git(root, work, "config", "core.precomposeunicode", "false");
  await mkdir(join(work, "docs"));
  await mkdir(join(work, ".aws"));
  await writeFile(join(work, ".aws", "private.md"), "# Must never leave private Git\n");
  if (excludedSpecial) await symlink("../docs/unchanged.md", join(work, ".aws", "link.md"));
  await symlink("unchanged.md", join(work, "docs", "link.md"));
  await writeFile(join(work, "docs", "unchanged.md"), "# Unchanged at H\n");
  if (exactHSource)
    await writeFile(join(work, "docs", "raw-context.md"), "\uFEFF# Immutable H\r\n\r\nline\r\n");
  await writeFile(join(work, "docs", "before.md"), "# Merge base\n");
  await writeFile(join(work, "docs", "deleted.md"), "# M-before deleted document\n");
  git(root, work, "add", ".");
  git(root, work, "commit", "-qm", "common");
  const M = git(root, work, "rev-parse", "HEAD");
  git(root, work, "branch", "proposal");
  await writeFile(join(work, "docs", "before.md"), "# Target base B\n");
  await writeFile(join(work, "docs", "target-only.md"), "# Base-only context\n");
  git(root, work, "add", ".");
  if (excludedSpecial)
    git(root, work, "update-index", "--add", "--cacheinfo", `160000,${M},.ssh/vendor.md`);
  git(root, work, "commit", "-qm", "target diverges");
  const B = git(root, work, "rev-parse", "HEAD");
  const baseTree = git(root, work, "rev-parse", "HEAD^{tree}");
  git(root, work, "switch", "-q", "proposal");
  if (emptyHead) git(root, work, "rm", "-rq", ".");
  else if (codeOnly) await writeFile(join(work, "code.ts"), "export const answer = 1;\n");
  else {
    git(root, work, "rm", "-q", "docs/deleted.md");
    await writeFile(join(work, "docs", "after.md"), "# Proposal after\n");
    await writeFile(join(work, "docs", "é.md"), "# Unicode at H\n");
    for (let index = 0; index < extraHeadDocs; index += 1)
      await writeFile(join(work, "docs", `extra-${index}.md`), `# Extra H ${index}\n`);
  }
  git(root, work, "add", ".");
  if (colliding) {
    const blob = git(root, work, "hash-object", "-w", "docs/é.md");
    git(root, work, "update-index", "--add", "--cacheinfo", `100644,${blob},docs/é.md`);
  }
  if (!emptyHead)
    git(root, work, "update-index", "--add", "--cacheinfo", `160000,${M},modules/example`);
  if (excludedSpecial)
    git(root, work, "update-index", "--add", "--cacheinfo", `160000,${M},.ssh/vendor.md`);
  git(root, work, "commit", "-qm", "proposal");
  const H = git(root, work, "rev-parse", "HEAD");
  const headTree = git(root, work, "rev-parse", "HEAD^{tree}");
  const unchangedBlob = emptyHead ? "" : git(root, work, "rev-parse", "HEAD:docs/unchanged.md");
  const target = join(root, "target.git");
  const fork = join(root, "fork.git");
  execFileSync("git", ["clone", "-q", "--bare", work, target], { env: gitEnv(root) });
  execFileSync("git", ["clone", "-q", "--bare", work, fork], { env: gitEnv(root) });
  // The caller checkout is deliberately no longer H; the provider may only use the pinned public objects.
  if (!colliding && !emptyHead) {
    await writeFile(join(work, "docs", "unchanged.md"), "# Mutable caller checkout, not H\n");
    git(root, work, "add", ".");
    git(root, work, "commit", "-qm", "caller checkout drifts after public clone");
  }
  const repositories = (id: number, owner: string) => ({
    id,
    full_name: `${owner}/docs`,
    private: false,
    visibility: "public",
  });
  let apiRequests = 0;
  const apiFetch = async (url: string, init: RequestInit) => {
    apiRequests += 1;
    expect(init.method).toBe("GET");
    const path = new URL(url).pathname;
    const body =
      path === "/repos/target/docs" || path === "/repositories/10"
        ? repositories(10, "target")
        : path === "/repositories/11"
          ? repositories(11, "fork")
          : path === "/repositories/10/git/ref/heads/main"
            ? { object: { type: "commit", sha: B } }
            : path === "/repos/target/docs/pulls/884"
              ? {
                  number: 884,
                  state: "open",
                  merged: false,
                  base: { ref: "main", sha: M, repo: repositories(10, "target") },
                  head: { sha: H, repo: repositories(11, "fork") },
                }
              : (() => {
                  throw new Error(`unexpected API path ${path}`);
                })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const requests: Buffer[] = [];
  const responseLengths: number[] = [];
  const responseByRequest = new Map<string, Buffer>();
  const objectFetch = async (url: string, init: RequestInit) => {
    const repository = url.includes("/fork/") ? fork : target;
    const discovery = init.method === "GET";
    const request = discovery ? undefined : Buffer.from(init.body as Buffer);
    if (request) requests.push(request);
    const key = `${url}/${init.method}/${request?.toString("hex") ?? ""}`;
    let bytes = responseByRequest.get(key);
    if (!bytes) {
      const result = spawnSync(
        "git",
        [
          "-c",
          "uploadpack.allowFilter=true",
          "-c",
          "uploadpack.allowAnySHA1InWant=true",
          "upload-pack",
          "--stateless-rpc",
          ...(discovery ? ["--http-backend-info-refs"] : []),
          repository,
        ],
        {
          input: request,
          maxBuffer: limit("changeSourcesGithub.acquisitionMaxBytes").value,
          env: {
            PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            HOME: root,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_PROTOCOL: "version=2",
            LANG: "C",
            LC_ALL: "C",
          },
        },
      );
      if (result.status !== 0) throw new Error(`native upload-pack exited ${result.status}`);
      bytes = result.stdout;
      responseByRequest.set(key, bytes);
    }
    responseLengths.push(bytes.length);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": discovery
          ? "application/x-git-upload-pack-advertisement"
          : "application/x-git-upload-pack-result",
      },
    });
  };
  return {
    root,
    work,
    scratch,
    B,
    H,
    M,
    baseTree,
    headTree,
    unchangedBlob,
    requests,
    responseLengths,
    apiRequestCount: () => apiRequests,
    apiFetch,
    objectFetch,
  };
}

/** Host-shaped source provider: real H bytes and extractor, no second binding. */
async function acquireSelectedHSource(
  host: GithubPrHSourceHostContext,
  repositoryPath = "docs/unchanged.md",
): Promise<GithubPrHSourceObservations> {
  const original = await readTrackedRepositoryFile(
    host.headWorkspace,
    repositoryPath,
    sourceExtractionMaxOriginalBytes(),
  );
  const mediaType = classifySourceMediaType(repositoryPath)!;
  const adapter = createDefaultSourceExtractorRegistry().resolve(mediaType)!;
  const extracted = await extractSourceRepresentation({
    adapter,
    bytes: original,
    mediaType,
    signal: host.signal,
  });
  const derivative = Buffer.from(extracted.derivative);
  const raw = createGithubPrHOriginalRepresentation(original);
  const readScope = ["."];
  const scopeSha256 = digestSourceReadScope({ repository: host.repository, readScope });
  const originIdSha256 = computeSourceOriginId({ repository: host.repository, repositoryPath });
  const observationId = computeSourceObservationId({
    originIdSha256,
    revision: host.headWorkspace.H,
    originalSha256: sha256Bytes(original),
    representationSha256: extracted.representation.representationSha256,
  });
  const inputId = computeSourceInputId(observationId);
  const originalInputId = `input-${canonicalDigest({ kind: "docsfab-h-source-original-input", observationId })}`;
  const canonicalLocator = trackedSourceCanonicalLocator(repositoryPath);
  const originalRegistration = registerTrackedRepositorySourceInput(host.externalInputs, {
    inputId: originalInputId,
    canonicalLocator,
    safeTitle: repositoryPath,
    contentDigestSha256: sha256Bytes(original),
    revision: host.headWorkspace.H,
    producerId: TRACKED_SOURCE_PRODUCER_ID,
    producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
  });
  const primaryRegistration = registerTrackedRepositorySourceInput(host.externalInputs, {
    inputId,
    canonicalLocator,
    safeTitle: repositoryPath,
    contentDigestSha256: sha256Bytes(derivative),
    revision: host.headWorkspace.H,
    producerId: TRACKED_SOURCE_PRODUCER_ID,
    producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
  });
  const observation = createSourceObservation({
    observationId,
    originIdSha256,
    inputId,
    registrationSha256: primaryRegistration.entrySha256,
    originalInputId,
    originalRegistrationSha256: originalRegistration.entrySha256,
    runIdSha256: host.runIdSha256,
    repository: host.repository,
    requestSha256: host.requestSha256,
    producerId: TRACKED_SOURCE_PRODUCER_ID,
    producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
    producerScopeSha256: scopeSha256,
    acquisitionReceiptSha256: computeAcquisitionReceiptSha256({
      repository: host.repository,
      repositoryPath,
      originalSha256: sha256Bytes(original),
      byteLength: original.byteLength,
      mediaType,
      readScopeSha256: scopeSha256,
      representationSha256: extracted.representation.representationSha256,
      observedAt: host.observedAt,
    }),
    observedAt: host.observedAt,
    original: {
      sha256: sha256Bytes(original),
      byteLength: original.length,
      mediaType,
      locatorSha256: canonicalDigest({
        schemaVersion: 1,
        kind: "docsfab-source-repository-locator",
        canonicalLocator,
      }),
      version: { kind: "repository-revision", revision: host.headWorkspace.H },
      repositoryPath,
    },
    representations: [extracted.representation, raw],
  });
  return {
    observations: [observation],
    producerScopes: [{ producerId: TRACKED_SOURCE_PRODUCER_ID, scopeSha256 }],
    readScope,
    handlers: {
      resolveDerivative: ({ observationId: id, representationId }) =>
        id === observationId && representationId === extracted.representation.representationId
          ? Buffer.from(derivative)
          : undefined,
      resolveOriginal: ({ observationId: id, representationId }) =>
        id === observationId && representationId === raw.representationId
          ? Buffer.from(original)
          : undefined,
      recordAccess: ({ observationId: id, representationId, stepId }) => {
        if (id !== observationId) throw new Error("foreign H source observation");
        const rawRead = representationId === raw.representationId;
        return recordExternalInputAccess(host.externalInputs, {
          inputId: rawRead ? originalInputId : inputId,
          stepId,
          outcome: "opened",
          observedContentDigestSha256: rawRead ? raw.sha256 : extracted.representation.sha256,
          accessorId: "docsfab-source-evidence",
          evidenceSha256s: [observation.observationSha256],
        }).observationSha256;
      },
      recordCitation: ({
        observationId: id,
        representationId,
        stepId,
        accessObservationSha256s,
        supportedClaimSha256,
      }) => {
        if (id !== observationId) throw new Error("foreign H source observation");
        const result = citeExternalInput(host.externalInputs, {
          inputId: representationId === raw.representationId ? originalInputId : inputId,
          stepId,
          role: "evidence",
          supportedClaimSha256,
          accessObservationSha256: accessObservationSha256s[0]!,
          unsupported: false,
        });
        if (result.kind !== "docsfab-external-input-citation")
          throw new Error("H source citation refused");
        return result.citationSha256;
      },
      dispose() {
        original.fill(0);
        derivative.fill(0);
      },
    },
  };
}

describe("GitHub PR callback review basis", () => {
  it(
    "composes changed PR and selected unchanged H source in one live binding, read and citation ledger",
    async () => {
      const f = await nativeFixture(false, false, false, false, 0, true);
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          const repositoryIdentitySha256 = createHash("sha256")
            .update(basis.headWorkspace.sourcePath)
            .digest("hex");
          const workspaceIdentitySha256 = workspaceIdentityDigest(basis.headWorkspace);
          expect(repositoryIdentitySha256).not.toBe(basis.headWorkspace.sourceIdentitySha256);
          expect(workspaceIdentitySha256).not.toBe(basis.headWorkspace.sourceIdentitySha256);
          expect(workspaceIdentitySha256).toBe(
            canonicalDigest({
              schemaVersion: 1,
              kind: "docsfab-source-workspace-identity",
              workspacePathSha256: createHash("sha256")
                .update(basis.headWorkspace.path)
                .digest("hex"),
              repositoryIdentitySha256,
              revision: basis.headWorkspace.revision,
            }),
          );
          const runId = "github-combined-source-run";
          const request: RunRequest = {
            runId,
            workflow: "review-documentation",
            workspacePath: basis.headWorkspace.path,
            repository: {
              sourcePath: basis.headWorkspace.sourcePath,
              requestedRevision: basis.headWorkspace.H,
              revision: basis.headWorkspace.H,
            },
            allowWrite: false,
          };
          const context = {
            runId,
            requestSha256: projectSourceRequestContext(
              request as unknown as Record<string, unknown>,
              {
                runId,
                repository: {
                  identitySha256: repositoryIdentitySha256,
                  revision: basis.headWorkspace.H,
                },
                workspaceIdentitySha256,
              },
            ),
            repository: {
              identitySha256: repositoryIdentitySha256,
              revision: basis.headWorkspace.H,
            },
            workspaceIdentitySha256,
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({
              sourceReadSkills: ["review-documentation"],
              sourceCiteSkills: ["review-documentation"],
            }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };
          const custody = await createGithubPrCustody(basis.acquisition, context, {
            basis,
            acquireHSourceObservations: (host) =>
              acquireSelectedHSource(host, "docs/raw-context.md"),
          });
          try {
            expect(custody.binding).not.toBeNull();
            expect(custody.sourceEvidence).not.toBeNull();
            expect(custody.sourceReference).not.toBeNull();
            const h = custody.observations.find(
              (observation) => observation.original.repositoryPath === "docs/raw-context.md",
            )!;
            expect(h).toBeDefined();
            expect(
              custody.snapshot.sourceSides.some((side) => side.path === "docs/raw-context.md"),
            ).toBe(false);
            expect(custody.binding!.observations.map((row) => row.observationId)).toContain(
              h.observationId,
            );
            // These unrelated runner ports must stay idle at pre-model admission.
            const options: WorkflowRunnerOptions = {
              harness: {
                async runStep() {
                  throw new Error("admission must not call the model harness");
                },
              },
              store: {
                async save() {
                  throw new Error("admission must not save a run record");
                },
              },
              repositoryScanner: {
                async scan() {
                  throw new Error("admission must not scan the repository");
                },
              },
              sourceEvidence: custody.sourceEvidence!,
              sourceObligationObserver: new LocalSourceObligationSourceObserver(
                basis.headWorkspace,
              ),
            };
            const runner = {
              options,
              id: () => runId,
              timestamp: () => context.observedAt,
            };
            const admittedRequest = { ...request, sourceBinding: custody.sourceReference! };
            const admission = admitWorkflowRunRequest(runner, admittedRequest);
            expect(admission.sourceCapability).toBeDefined();
            const accessBeforeSubstitution = listExternalInputAccessObservations(
              custody.externalInputs,
            );
            const citationsBeforeSubstitution = createExternalInputCitationLedger(
              custody.externalInputs,
            ).citations;
            for (const { substituted, refusal } of [
              {
                substituted: {
                  ...admittedRequest,
                  repository: {
                    ...request.repository,
                    sourcePath: `${request.repository.sourcePath}-other`,
                  },
                },
                refusal: "repository-mismatch",
              },
              {
                substituted: {
                  ...admittedRequest,
                  repository: { ...request.repository, revision: "f".repeat(40) },
                },
                refusal: "repository-mismatch",
              },
              {
                substituted: { ...admittedRequest, instruction: "A different request field" },
                refusal: "request-mismatch",
              },
            ]) {
              expect(() => admitWorkflowRunRequest(runner, substituted)).toThrow(refusal);
            }
            expect(listExternalInputAccessObservations(custody.externalInputs)).toEqual(
              accessBeforeSubstitution,
            );
            expect(createExternalInputCitationLedger(custody.externalInputs).citations).toEqual(
              citationsBeforeSubstitution,
            );
            const source = admission.sourceCapability!;
            const step = source.forStep({
              stepId: "review-evidence",
              workflow: "review-documentation",
              readSource: true,
              citeSource: true,
              remainingBudgetBytes: context.policy.perStepBudgetBytes,
            })!;
            const citer = source.citerForStep({
              stepId: "review-evidence",
              workflow: "review-documentation",
              readSource: true,
              citeSource: true,
              remainingBudgetBytes: context.policy.perStepBudgetBytes,
            })!;
            const listing = step.listSources();
            const hDerivative = listing.find(
              (entry) => entry.observationId === h.observationId && entry.form === undefined,
            )!;
            const hRaw = listing.find(
              (entry) =>
                entry.observationId === h.observationId && entry.form === "exact-original-utf8",
            )!;
            const pr = listing.find(
              (entry) => entry.observationId !== h.observationId && entry.form === undefined,
            )!;
            expect(hDerivative).toBeDefined();
            expect(hRaw).toBeDefined();
            expect(pr).toBeDefined();
            for (const listed of [hDerivative, hRaw, pr]) {
              const selection = {
                claim: "The selected GitHub source supports this review.",
                observationId: listed.observationId,
                representationId: listed.representationId,
                spanIds: [listed.spanId],
              };
              expect(
                step.read(
                  selection,
                  listed.form === "exact-original-utf8"
                    ? { screen: ({ text }) => Buffer.byteLength(text, "utf8") }
                    : undefined,
                ).text,
              ).toContain("#");
              expect(citer.cite(selection).spanCitationSha256s).toHaveLength(1);
            }
            expect(
              step.read(
                {
                  observationId: h.observationId,
                  representationId: hRaw.representationId,
                  spanIds: [hRaw.spanId],
                },
                { screen: ({ text }) => Buffer.byteLength(text, "utf8") },
              ).text,
            ).toBe("\uFEFF# Immutable H\r\n\r\nline\r\n");
            expect(
              step.read({
                observationId: h.observationId,
                representationId: hDerivative.representationId,
                spanIds: [hDerivative.spanId],
              }).text,
            ).toBe("# Immutable H");
            expect(
              listExternalInputAccessObservations(custody.externalInputs).length,
            ).toBeGreaterThanOrEqual(3);
            expect(
              createExternalInputCitationLedger(custody.externalInputs).citations.length,
            ).toBeGreaterThanOrEqual(3);
          } finally {
            custody.dispose();
          }
        },
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a substituted repository identity before composing H source custody",
    async () => {
      const f = await nativeFixture(false, false, false, false, 0, true);
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          const context = {
            runId: "github-substituted-repository-run",
            requestSha256: createHash("sha256")
              .update("substituted-repository-request")
              .digest("hex"),
            repository: {
              identitySha256: "0".repeat(64),
              revision: basis.headWorkspace.H,
            },
            workspaceIdentitySha256: workspaceIdentityDigest(basis.headWorkspace),
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({ sourceReadSkills: ["review-documentation"] }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };

          let sourceAcquisitions = 0;
          const options = {
            basis,
            acquireHSourceObservations: async (host: GithubPrHSourceHostContext) => {
              sourceAcquisitions++;
              return acquireSelectedHSource(host, "docs/raw-context.md");
            },
          };
          for (const substituted of [
            context,
            {
              ...context,
              repository: {
                identitySha256: createHash("sha256")
                  .update(basis.headWorkspace.sourcePath)
                  .digest("hex"),
                revision: basis.headWorkspace.H,
              },
              workspaceIdentitySha256: "0".repeat(64),
            },
            {
              ...context,
              repository: {
                identitySha256: basis.headWorkspace.sourceIdentitySha256,
                revision: basis.headWorkspace.H,
              },
              workspaceIdentitySha256: basis.headWorkspace.sourceIdentitySha256,
            },
          ]) {
            await expect(
              createGithubPrCustody(basis.acquisition, substituted, options),
            ).rejects.toMatchObject({ code: "github-pr-source-head-substituted" });
          }
          expect(sourceAcquisitions).toBe(0);
        },
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "keeps minted H source reads and citations available after callback settlement until custody disposal",
    async () => {
      const f = await nativeFixture(true);
      let retainedBasis: Parameters<typeof assertGithubPrReviewBasis>[0] | undefined;
      const result = await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          retainedBasis = basis;
          const context = {
            runId: "github-post-callback-custody-run",
            requestSha256: createHash("sha256").update("post-callback-request").digest("hex"),
            repository: {
              identitySha256: createHash("sha256")
                .update(basis.headWorkspace.sourcePath)
                .digest("hex"),
              revision: basis.headWorkspace.H,
            },
            workspaceIdentitySha256: workspaceIdentityDigest(basis.headWorkspace),
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({
              sourceReadSkills: ["review-documentation"],
              sourceCiteSkills: ["review-documentation"],
            }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };
          const custody = await createGithubPrCustody(basis.acquisition, context, {
            basis,
            acquireHSourceObservations: acquireSelectedHSource,
          });
          return { custody, context };
        },
      );
      const { custody, context } = result;
      try {
        expect(() => assertGithubPrReviewBasis(retainedBasis!)).toThrow(
          "github-pr-review-basis-authority-required",
        );
        expect(await readdir(f.scratch)).toEqual([]);
        const source = custody.sourceEvidence!.service.bindRun(custody.sourceReference!, {
          runId: context.runId,
          requestSha256: context.requestSha256,
          repository: context.repository,
          workspaceIdentitySha256: context.workspaceIdentitySha256,
          repositoryContentDigest: context.repositoryContentDigest,
        });
        const options = {
          stepId: "retained-review-evidence",
          workflow: "review-documentation",
          readSource: true,
          citeSource: true,
          remainingBudgetBytes: context.policy.perStepBudgetBytes,
        };
        const reader = source.forStep(options)!;
        const citer = source.citerForStep(options)!;
        const listed = reader.listSources().find((entry) => entry.form === undefined)!;
        const selection = {
          claim: "The retained H documentation supports this review.",
          observationId: listed.observationId,
          representationId: listed.representationId,
          spanIds: [listed.spanId],
        };
        expect(reader.read(selection).text).toContain("Unchanged at H");
        expect(citer.cite(selection).spanCitationSha256s).toHaveLength(1);
        expect(listExternalInputAccessObservations(custody.externalInputs)).toHaveLength(1);
        expect(createExternalInputCitationLedger(custody.externalInputs).citations).toHaveLength(1);
        custody.dispose();
        expect(() => reader.read(selection)).toThrow("github-pr-custody-disposed");
      } finally {
        custody.dispose();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses to seal H custody when the callback basis is revoked during awaited byte verification",
    async () => {
      const f = await nativeFixture(true);
      let releaseRead: () => void = () => undefined;
      const heldRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let enteredRead: () => void = () => undefined;
      const readEntered = new Promise<void>((resolve) => {
        enteredRead = resolve;
      });
      type Custody = Awaited<ReturnType<typeof createGithubPrCustody>>;
      type Outcome = { kind: "fulfilled"; custody: Custody } | { kind: "rejected"; error: unknown };
      let custodyOutcome: Promise<Outcome> | undefined;
      let retainedBasis: Parameters<typeof assertGithubPrReviewBasis>[0] | undefined;
      let handlerDisposed = false;
      custodyReadCloseGate.active = false;
      custodyReadCloseGate.path = "";
      custodyReadCloseGate.observedPaths = [];
      custodyReadCloseGate.opens = 0;
      custodyReadCloseGate.entered = enteredRead;
      custodyReadCloseGate.release = heldRead;
      try {
        const { outcome } = await withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
          },
          async (basis) => {
            retainedBasis = basis;
            const context = {
              runId: "github-preseal-revoked-run",
              requestSha256: createHash("sha256").update("preseal-revoked-request").digest("hex"),
              repository: {
                identitySha256: createHash("sha256")
                  .update(basis.headWorkspace.sourcePath)
                  .digest("hex"),
                revision: basis.headWorkspace.H,
              },
              workspaceIdentitySha256: workspaceIdentityDigest(basis.headWorkspace),
              repositoryContentDigest: basis.headInventory.inventorySha256,
              policy: createSourceStepPolicy({ sourceReadSkills: ["review-documentation"] }),
              observedAt: "2026-10-17T00:00:00.000Z",
            };
            const outcome = createGithubPrCustody(basis.acquisition, context, {
              basis,
              acquireHSourceObservations: async (host) => {
                const source = await acquireSelectedHSource(host);
                custodyReadCloseGate.path = join(
                  await realpath(host.headWorkspace.path),
                  "docs/unchanged.md",
                );
                custodyReadCloseGate.opens = 0;
                custodyReadCloseGate.active = true;
                return {
                  ...source,
                  handlers: {
                    ...source.handlers,
                    dispose: () => {
                      handlerDisposed = true;
                      source.handlers.dispose();
                    },
                  },
                };
              },
            }).then<Outcome, Outcome>(
              (custody) => ({ kind: "fulfilled", custody }),
              (error) => ({ kind: "rejected", error }),
            );
            custodyOutcome = outcome;
            const first = await Promise.race([
              readEntered.then(() => ({ kind: "entered" as const })),
              outcome.then((value) => ({ kind: "settled" as const, value })),
            ]);
            if (first.kind === "settled")
              throw new Error(
                `custody settled before verified-read barrier: ${first.value.kind}; expected=${custodyReadCloseGate.path}; observed=${custodyReadCloseGate.observedPaths.join(",")}`,
              );
            expect(custodyReadCloseGate.opens).toBe(2);
            assertGithubPrReviewBasis(basis);
            return { outcome };
          },
        );
        expect(() => assertGithubPrReviewBasis(retainedBasis!)).toThrow(
          "github-pr-review-basis-authority-required",
        );
        expect(await readdir(f.scratch)).toEqual([]);
        let settled = false;
        void outcome.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        releaseRead();
        const result = await outcome;
        expect(result.kind).toBe("rejected");
        if (result.kind === "rejected")
          expect(result.error).toMatchObject({ code: "github-pr-review-basis-authority-required" });
        expect(handlerDisposed).toBe(true);
        expect(custodyReadCloseGate.opens).toBe(2);
      } finally {
        releaseRead();
        const result = await custodyOutcome;
        if (result?.kind === "fulfilled") result.custody.dispose();
        custodyReadCloseGate.active = false;
        custodyReadCloseGate.path = "";
        custodyReadCloseGate.observedPaths = [];
        custodyReadCloseGate.opens = 0;
        custodyReadCloseGate.entered = () => undefined;
        custodyReadCloseGate.release = Promise.resolve();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a differently hashed second H derivative before sealing a shared input registration",
    async () => {
      const f = await nativeFixture(true);
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          const context = {
            runId: "github-second-derivative-run",
            requestSha256: createHash("sha256").update("second-derivative-request").digest("hex"),
            repository: {
              identitySha256: createHash("sha256")
                .update(basis.headWorkspace.sourcePath)
                .digest("hex"),
              revision: basis.headWorkspace.H,
            },
            workspaceIdentitySha256: workspaceIdentityDigest(basis.headWorkspace),
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({
              sourceReadSkills: ["review-documentation"],
              sourceCiteSkills: ["review-documentation"],
            }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };
          let matchingRepresentationId = "";
          const withSecondDerivative = (sameBytes: boolean) => ({
            basis,
            acquireHSourceObservations: async (host: GithubPrHSourceHostContext) => {
              const source = await acquireSelectedHSource(host);
              const observation = source.observations[0]!;
              const primary = observation.representations.find((row) => row.form === undefined)!;
              const secondBytes = sameBytes
                ? Buffer.from(
                    source.handlers.resolveDerivative({
                      observationId: observation.observationId,
                      representationId: primary.representationId,
                    })!,
                  )
                : Buffer.from("#");
              const secondSha256 = sha256Bytes(secondBytes);
              const extractor = Array.from({ length: 32 }, (_, index) => ({
                ...primary.extractor,
                optionsSha256: canonicalDigest({
                  kind: "docsfab-second-h-derivative-test",
                  index,
                }),
              })).find(
                (candidate) =>
                  computeSourceRepresentationId({
                    originalSha256: observation.original.sha256,
                    extractor: candidate,
                  }) > primary.representationId,
              );
              if (extractor === undefined)
                throw new Error("second H representation order unavailable");
              const pieces = sameBytes
                ? primary.spans
                : [
                    {
                      startByte: 0,
                      endByte: 1,
                      locator: { kind: "text" as const, startByte: 0, endByte: 1 },
                    },
                  ];
              const second = createSourceRepresentation({
                sha256: secondSha256,
                byteLength: secondBytes.length,
                extractor,
                originalSha256: observation.original.sha256,
                spans: pieces.map(({ startByte, endByte, locator }) => ({
                  spanId: computeSourceSpanId({
                    originalSha256: observation.original.sha256,
                    extractor,
                    derivativeSha256: secondSha256,
                    startByte,
                    endByte,
                    locator,
                  }),
                  startByte,
                  endByte,
                  locator,
                })),
                completeness: "complete",
                limitations: [],
              });
              if (sameBytes) matchingRepresentationId = second.representationId;
              const {
                schemaVersion: _schemaVersion,
                kind: _kind,
                observationSha256: _digest,
                ...body
              } = observation;
              return {
                ...source,
                observations: [
                  createSourceObservation({
                    ...body,
                    representations: [...observation.representations, second],
                  }),
                ],
                handlers: {
                  ...source.handlers,
                  resolveDerivative: (
                    selection: Parameters<GithubPrHSourcePrivateHandlers["resolveDerivative"]>[0],
                  ) =>
                    selection.representationId === second.representationId
                      ? Buffer.from(secondBytes)
                      : source.handlers.resolveDerivative(selection),
                },
              };
            },
          });
          const admitted = await createGithubPrCustody(
            basis.acquisition,
            context,
            withSecondDerivative(true),
          );
          try {
            const source = admitted.sourceEvidence!.service.bindRun(admitted.sourceReference!, {
              runId: context.runId,
              requestSha256: context.requestSha256,
              repository: context.repository,
              workspaceIdentitySha256: context.workspaceIdentitySha256,
              repositoryContentDigest: context.repositoryContentDigest,
            });
            const options = {
              stepId: "matching-second-derivative",
              workflow: "review-documentation",
              readSource: true,
              citeSource: true,
              remainingBudgetBytes: context.policy.perStepBudgetBytes,
            };
            const reader = source.forStep(options)!;
            const citer = source.citerForStep(options)!;
            const listed = reader
              .listSources()
              .find((entry) => entry.representationId === matchingRepresentationId)!;
            const selection = {
              claim: "The matching second view supports this review.",
              observationId: listed.observationId,
              representationId: listed.representationId,
              spanIds: [listed.spanId],
            };
            expect(reader.read(selection).text).toContain("Unchanged at H");
            expect(citer.cite(selection).spanCitationSha256s).toHaveLength(1);
          } finally {
            admitted.dispose();
          }
          const different = await createGithubPrCustody(
            basis.acquisition,
            context,
            withSecondDerivative(false),
          ).then<
            | { kind: "fulfilled"; custody: Awaited<ReturnType<typeof createGithubPrCustody>> }
            | { kind: "rejected"; error: unknown },
            | { kind: "fulfilled"; custody: Awaited<ReturnType<typeof createGithubPrCustody>> }
            | { kind: "rejected"; error: unknown }
          >(
            (custody) => ({ kind: "fulfilled", custody }),
            (error) => ({ kind: "rejected", error }),
          );
          if (different.kind === "fulfilled") different.custody.dispose();
          expect(different.kind).toBe("rejected");
          if (different.kind === "rejected")
            expect(different.error).toMatchObject({
              message: "github-pr-h-source-registration-substituted",
            });
        },
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "binds selected H documentation for a code-only PR with no changed documentation sides",
    async () => {
      const f = await nativeFixture(true);
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          const context = {
            runId: "github-code-only-source-run",
            requestSha256: createHash("sha256").update("code-only-request").digest("hex"),
            repository: {
              identitySha256: createHash("sha256")
                .update(basis.headWorkspace.sourcePath)
                .digest("hex"),
              revision: basis.headWorkspace.H,
            },
            workspaceIdentitySha256: workspaceIdentityDigest(basis.headWorkspace),
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({
              sourceReadSkills: ["review-documentation"],
              sourceCiteSkills: ["review-documentation"],
            }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };
          const custody = await createGithubPrCustody(basis.acquisition, context, {
            basis,
            acquireHSourceObservations: acquireSelectedHSource,
          });
          try {
            expect(custody.snapshot.sourceSides).toEqual([]);
            expect(custody.observations).toHaveLength(1);
            expect(custody.binding?.observations).toHaveLength(1);
            const service = custody.sourceEvidence!.service.bindRun(custody.sourceReference!, {
              runId: context.runId,
              requestSha256: context.requestSha256,
              repository: context.repository,
              workspaceIdentitySha256: context.workspaceIdentitySha256,
              repositoryContentDigest: context.repositoryContentDigest,
            });
            const options = {
              stepId: "code-only-review-evidence",
              workflow: "review-documentation",
              readSource: true,
              citeSource: true,
              remainingBudgetBytes: context.policy.perStepBudgetBytes,
            };
            const reader = service.forStep(options)!;
            const citer = service.citerForStep(options)!;
            const listed = reader.listSources().find((entry) => entry.form === undefined)!;
            expect(listed.observationId).toBe(custody.observations[0]!.observationId);
            const selection = {
              claim: "The unchanged H documentation supplies context for this code-only PR.",
              observationId: listed.observationId,
              representationId: listed.representationId,
              spanIds: [listed.spanId],
            };
            expect(reader.read(selection).text).toContain("Unchanged at H");
            expect(citer.cite(selection).spanCitationSha256s).toHaveLength(1);
            expect(listExternalInputAccessObservations(custody.externalInputs)).toHaveLength(1);
            expect(
              createExternalInputCitationLedger(custody.externalInputs).citations,
            ).toHaveLength(1);
          } finally {
            custody.dispose();
          }
        },
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "rejects detached H access and citation receipts from the shared source ledger",
    async () => {
      const f = await nativeFixture();
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          const context = {
            runId: "github-detached-ledger-run",
            requestSha256: createHash("sha256").update("detached-ledger-request").digest("hex"),
            repository: {
              identitySha256: createHash("sha256")
                .update(basis.headWorkspace.sourcePath)
                .digest("hex"),
              revision: basis.headWorkspace.H,
            },
            workspaceIdentitySha256: workspaceIdentityDigest(basis.headWorkspace),
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({
              sourceReadSkills: ["review-documentation"],
              sourceCiteSkills: ["review-documentation"],
            }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };
          const bind = (custody: Awaited<ReturnType<typeof createGithubPrCustody>>) => {
            const service = custody.sourceEvidence!.service.bindRun(custody.sourceReference!, {
              runId: context.runId,
              requestSha256: context.requestSha256,
              repository: context.repository,
              workspaceIdentitySha256: context.workspaceIdentitySha256,
              repositoryContentDigest: context.repositoryContentDigest,
            });
            const options = {
              stepId: "ledger-review-evidence",
              workflow: "review-documentation",
              readSource: true,
              citeSource: true,
              remainingBudgetBytes: context.policy.perStepBudgetBytes,
            };
            const reader = service.forStep(options)!;
            const citer = service.citerForStep(options)!;
            const h = custody.observations.find(
              (row) => row.original.repositoryPath === "docs/unchanged.md",
            )!;
            const listed = reader
              .listSources()
              .find(
                (entry) => entry.observationId === h.observationId && entry.form === undefined,
              )!;
            return {
              reader,
              citer,
              selection: {
                claim: "The H document supports this review.",
                observationId: listed.observationId,
                representationId: listed.representationId,
                spanIds: [listed.spanId],
              },
            };
          };
          const detachedAccess = await createGithubPrCustody(basis.acquisition, context, {
            basis,
            acquireHSourceObservations: async (host) => {
              const source = await acquireSelectedHSource(host);
              return {
                ...source,
                handlers: {
                  ...source.handlers,
                  recordAccess: () => "0".repeat(64),
                },
              };
            },
          });
          try {
            const { reader, selection } = bind(detachedAccess);
            expect(() => reader.read(selection)).toThrow("github-pr-h-source-access-detached");
          } finally {
            detachedAccess.dispose();
          }
          const detachedCitation = await createGithubPrCustody(basis.acquisition, context, {
            basis,
            acquireHSourceObservations: async (host) => {
              const source = await acquireSelectedHSource(host);
              return {
                ...source,
                handlers: {
                  ...source.handlers,
                  recordCitation: () => "0".repeat(64),
                },
              };
            },
          });
          try {
            const { reader, citer, selection } = bind(detachedCitation);
            expect(reader.read(selection).text).toContain("Unchanged at H");
            expect(() => citer.cite(selection)).toThrow("github-pr-h-source-citation-detached");
          } finally {
            detachedCitation.dispose();
          }
        },
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses cloned basis, wrong request, duplicate H observation and substituted H original",
    async () => {
      const f = await nativeFixture();
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          const context = {
            runId: "combined-negative-run",
            requestSha256: createHash("sha256").update("combined-negative-request").digest("hex"),
            repository: {
              identitySha256: createHash("sha256")
                .update(basis.headWorkspace.sourcePath)
                .digest("hex"),
              revision: basis.headWorkspace.H,
            },
            workspaceIdentitySha256: workspaceIdentityDigest(basis.headWorkspace),
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({ sourceReadSkills: ["review-documentation"] }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };
          await expect(
            createGithubPrCustody(basis.acquisition, context, {
              basis: { ...basis },
              acquireHSourceObservations: acquireSelectedHSource,
            }),
          ).rejects.toThrow("github-pr-review-basis-authority-required");
          await expect(
            createGithubPrCustody(basis.acquisition, context, {
              basis,
              acquireHSourceObservations: async (host) => {
                const result = await acquireSelectedHSource(host);
                const {
                  schemaVersion: _schemaVersion,
                  kind: _kind,
                  observationSha256: _digest,
                  ...body
                } = result.observations[0]!;
                return {
                  ...result,
                  observations: [
                    createSourceObservation({
                      ...body,
                      requestSha256: createHash("sha256").update("other-request").digest("hex"),
                    }),
                  ],
                };
              },
            }),
          ).rejects.toThrow("github-pr-h-source-substituted");
          await expect(
            createGithubPrCustody(basis.acquisition, context, {
              basis,
              acquireHSourceObservations: async (host) => {
                const result = await acquireSelectedHSource(host);
                return {
                  ...result,
                  observations: [result.observations[0]!, result.observations[0]!],
                };
              },
            }),
          ).rejects.toThrow("github-pr-h-source-substituted");
          await expect(
            createGithubPrCustody(basis.acquisition, context, {
              basis,
              acquireHSourceObservations: async (host) => {
                const result = await acquireSelectedHSource(host);
                return {
                  ...result,
                  handlers: {
                    ...result.handlers,
                    resolveOriginal: () => Buffer.from("# Mutable caller checkout, not H\n"),
                  },
                };
              },
            }),
          ).rejects.toThrow("github-pr-h-source-original-substituted");
          await expect(
            createGithubPrCustody(basis.acquisition, context, {
              basis,
              acquireHSourceObservations: (host) =>
                acquireSelectedHSource(host, "docs/target-only.md"),
            }),
          ).rejects.toMatchObject({ code: "not-tracked" });
        },
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );
  it(
    "registers the exact fork H tree and genuine inventory while keeping B context distinct from M",
    async () => {
      const f = await nativeFixture();
      let retained: unknown;
      let retainedBasis: Parameters<typeof assertGithubPrReviewBasis>[0] | undefined;
      let retainedBase: Parameters<typeof assertGithubPrBaseDocumentationDescriptor>[0] | undefined;
      const answer = await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          retained = basis.headWorkspace;
          retainedBasis = basis;
          assertGithubPrReviewBasis(basis);
          expect(() => assertGithubPrReviewBasis({ ...basis })).toThrow(
            "github-pr-review-basis-authority-required",
          );
          expect(basis.acquisition.graph).toMatchObject({
            B: f.B,
            H: f.H,
            M: f.M,
            baseTree: f.baseTree,
            headTree: f.headTree,
          });
          expect(basis.headWorkspace).toMatchObject({
            sourceKind: "github-pr-head",
            requestedRevision: f.H,
            revision: f.H,
            headTree: f.headTree,
            headEntriesSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          });
          const exact = await readTrackedRepositoryFile(
            basis.headWorkspace,
            "docs/unchanged.md",
            1024,
          );
          expect(exact.toString("utf8")).toBe("# Unchanged at H\n");
          expect(
            createHash("sha1").update(`blob ${exact.length}\0`).update(exact).digest("hex"),
          ).toBe(f.unchangedBlob);
          expect(basis.headInventory.repositoryRevision).toBe(f.H);
          expect(git(f.root, f.work, "rev-parse", "HEAD")).not.toBe(f.H);
          expect(
            basis.acquisition.sides.some(
              (side) =>
                side.side === "before" &&
                side.path === "docs/deleted.md" &&
                side.repositoryId === 10 &&
                side.bytes.toString("utf8") === "# M-before deleted document\n",
            ),
          ).toBe(true);
          expect(
            (await readTrackedRepositoryFile(basis.headWorkspace, "docs/é.md", 1024)).toString(
              "utf8",
            ),
          ).toBe("# Unicode at H\n");
          expect(f.B).not.toBe(f.M);
          assertGithubPrBaseDocumentationDescriptor(basis.baseDocumentation);
          retainedBase = basis.baseDocumentation;
          expect(() =>
            assertGithubPrBaseDocumentationDescriptor({ ...basis.baseDocumentation }),
          ).toThrow("github-pr-base-documentation-authority-required");
          expect(basis.baseDocumentation).toMatchObject({
            targetRepositoryId: 10,
            B: f.B,
            baseTree: f.baseTree,
          });
          expect(
            basis.baseDocumentation.entries.some((entry) => entry.path === "docs/target-only.md"),
          ).toBe(true);
          const basePaths = basis.baseDocumentation.entries.map((entry) => entry.path);
          expect(basePaths).toEqual(
            [...basePaths].sort((left, right) =>
              Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
            ),
          );
          expect(f.requests.length).toBeGreaterThan(0);
          expect(basis.acquisition.metrics.responseBytes).toBe(
            f.responseLengths.reduce((total, length) => total + length, 0),
          );
          expect(basis.acquisition.metadataRequests).toBe(f.apiRequestCount());
          const entries = await listTrackedRepositoryEntries(basis.headWorkspace);
          expect(entries).toContainEqual({ path: "docs/link.md", kind: "symlink" });
          expect(entries).toContainEqual({ path: "modules/example", kind: "submodule" });
          expect(
            entries.some((entry) => entry.kind === "excluded" && entry.path === undefined),
          ).toBe(true);
          await expect(
            readTrackedRepositoryFile(basis.headWorkspace, "docs/link.md", 1024),
          ).rejects.toMatchObject({ code: "unsafe-kind" });
          await expect(
            readTrackedRepositoryFile(basis.headWorkspace, ".aws/private.md", 1024),
          ).rejects.toMatchObject({ code: "unsafe-kind" });
          return "consumed";
        },
      );
      expect(answer).toBe("consumed");
      expect(() => assertActiveRepositoryWorkspace(retained)).toThrow();
      expect(() => assertGithubPrReviewBasis(retainedBasis!)).toThrow(
        "github-pr-review-basis-authority-required",
      );
      expect(() => assertGithubPrBaseDocumentationDescriptor(retainedBase!)).toThrow(
        "github-pr-base-documentation-authority-required",
      );
    },
    testTimeoutMs(120_000),
  );

  it(
    "rechecks immutable PR metadata after H export and inventory before callback admission",
    async () => {
      const f = await nativeFixture();
      let drift = false;
      let latePullReads = 0;
      const originalInventory = repositoryInventory.buildRepositoryDiscoveryInventory;
      const inventory = vi
        .spyOn(repositoryInventory, "buildRepositoryDiscoveryInventory")
        .mockImplementationOnce(async (options) => {
          const result = await originalInventory(options);
          drift = true;
          return result;
        });
      let consumed = false;
      try {
        await expect(
          withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              objectFetch: f.objectFetch,
              apiFetch: async (url, init) => {
                const response = await f.apiFetch(url, init);
                if (!drift || new URL(url).pathname !== "/repos/target/docs/pulls/884")
                  return response;
                latePullReads += 1;
                const metadata = (await response.json()) as { head: Record<string, unknown> };
                return new Response(
                  JSON.stringify({ ...metadata, head: { ...metadata.head, sha: "f".repeat(40) } }),
                  { status: 200, headers: { "content-type": "application/json" } },
                );
              },
            },
            async () => {
              consumed = true;
            },
          ),
        ).rejects.toMatchObject({ code: "github-pr-metadata-drift" });
        expect(drift).toBe(true);
        expect(latePullReads).toBe(1);
        expect(consumed).toBe(false);
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        inventory.mockRestore();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "omits excluded H symlink and gitlink names from the registered tracked view, inventory and B descriptor",
    async () => {
      const f = await nativeFixture(false, false, false, true);
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          const tracked = await listTrackedRepositoryEntries(basis.headWorkspace);
          expect(tracked).toContainEqual({ path: "docs/link.md", kind: "symlink" });
          expect(tracked).toContainEqual({ path: "modules/example", kind: "submodule" });
          for (const path of [".aws/link.md", ".ssh/vendor.md"]) {
            expect(tracked.some((entry) => entry.path === path)).toBe(false);
            expect(basis.headInventory.files.some((file) => file.path === path)).toBe(false);
            expect(basis.headInventory.documents.some((document) => document.path === path)).toBe(
              false,
            );
            expect(basis.baseDocumentation.entries.some((entry) => entry.path === path)).toBe(
              false,
            );
            await expect(
              readTrackedRepositoryFile(basis.headWorkspace, path, 1024),
            ).rejects.toThrow();
          }
          for (const directory of [".aws", ".ssh"]) {
            await expect(
              filesystem.lstat(join(basis.headWorkspace.path, directory)),
            ).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        },
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "counts completed H Git reads and partial filesystem writes as stall progress and samples metrics after export",
    async () => {
      const f = await nativeFixture();
      const baseNow = performance.now();
      let syntheticElapsed = 0;
      const clock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => baseNow + syntheticElapsed);
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      workspaceProgress.active = true;
      workspaceProgress.exportStarted = false;
      workspaceProgress.partialBytes = 4;
      workspaceProgress.writes = 0;
      workspaceProgress.pauseAfterWrites = 5;
      workspaceProgress.advanceGitChunks = true;
      workspaceProgress.gitChunks = 0;
      workspaceProgress.writeEntered = entered;
      workspaceProgress.releaseWrite = new Promise<void>((resolve) => {
        release = resolve;
      });
      workspaceProgress.advance = () => {
        syntheticElapsed += 30;
      };
      const limits = {
        environment: { DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS: "50" },
        hostFile: null,
        projectFile: null,
      };
      try {
        const acquisition = withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            limits,
          },
          async (basis) => {
            expect(
              (
                await readTrackedRepositoryFile(basis.headWorkspace, "docs/unchanged.md", 1024)
              ).toString("utf8"),
            ).toBe("# Unchanged at H\n");
            expect(workspaceProgress.writes).toBeGreaterThan(3);
            expect(workspaceProgress.gitChunks).toBeGreaterThanOrEqual(2);
            expect(syntheticElapsed).toBeGreaterThan(50);
            expect(basis.acquisition.metrics.elapsedMs).toBeGreaterThanOrEqual(syntheticElapsed);
          },
        );
        void acquisition.catch(() => undefined);
        await Promise.race([
          reached,
          acquisition.then(() => {
            throw new Error("H export completed without the expected fifth partial write.");
          }),
        ]);
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        release();
        await acquisition;
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        release();
        workspaceProgress.active = false;
        workspaceProgress.exportStarted = false;
        workspaceProgress.partialBytes = 0;
        workspaceProgress.pauseAfterWrites = 0;
        workspaceProgress.advanceGitChunks = false;
        workspaceProgress.gitChunks = 0;
        workspaceProgress.releaseWrite = Promise.resolve();
        workspaceProgress.advance = () => undefined;
        clock.mockRestore();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a truly motionless H filesystem write with named stall evidence and no callback",
    async () => {
      const f = await nativeFixture();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      workspaceProgress.active = true;
      workspaceProgress.exportStarted = false;
      workspaceProgress.partialBytes = 0;
      workspaceProgress.holdFirstWrite = true;
      workspaceProgress.writeEntered = entered;
      workspaceProgress.releaseWrite = new Promise<void>((resolve) => {
        release = resolve;
      });
      const beforeRoots = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("docsfab-github-head-"),
      );
      let consumed = false;
      try {
        const acquisition = withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            limits: {
              environment: { DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS: "1000" },
              hostFile: null,
              projectFile: null,
            },
          },
          async () => {
            consumed = true;
          },
        );
        void acquisition.catch(() => undefined);
        await reached;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
        release();
        await expect(acquisition).rejects.toMatchObject({
          code: "per-blob-timeout",
          evidence: {
            phase: "materialization",
            quantity: { unit: "milliseconds", limit: "1000" },
          },
          limitRefusal: expect.stringContaining("repository-workspace-export-stall-ms-bound"),
        });
        expect(consumed).toBe(false);
        expect(await readdir(f.scratch)).toEqual([]);
        expect(
          (await readdir(tmpdir())).filter((name) => name.startsWith("docsfab-github-head-")),
        ).toEqual(beforeRoots);
      } finally {
        release();
        workspaceProgress.active = false;
        workspaceProgress.holdFirstWrite = false;
        workspaceProgress.releaseWrite = Promise.resolve();
      }
    },
    testTimeoutMs(120_000),
  );

  it.each(["mkdtemp", "mkdir"] as const)(
    "refuses an H workspace setup %s that crosses the configured no-progress window",
    async (phase) => {
      const f = await nativeFixture();
      const realNow = performance.now.bind(performance);
      const stallMs = 10_000;
      let advanced = false;
      workspaceSetupGate.phase = phase;
      workspaceSetupGate.advance = () => {
        advanced = true;
      };
      const clock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => realNow() + (advanced ? stallMs + 1 : 0));
      let consumed = false;
      try {
        await expect(
          withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              apiFetch: f.apiFetch,
              objectFetch: f.objectFetch,
              limits: {
                environment: { DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS: String(stallMs) },
                hostFile: null,
                projectFile: null,
              },
            },
            async () => {
              consumed = true;
            },
          ),
        ).rejects.toMatchObject({
          code: "aggregate-timeout",
          evidence: {
            phase: "materialization",
            quantity: { unit: "milliseconds", limit: String(stallMs) },
          },
          limitRefusal: expect.stringContaining("repository-workspace-export-stall-ms-bound"),
        });
        expect(advanced).toBe(true);
        expect(consumed).toBe(false);
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        clock.mockRestore();
        workspaceSetupGate.phase = "";
        workspaceSetupGate.advance = () => undefined;
      }
    },
    testTimeoutMs(120_000),
  );

  it.each(["lstat", "realpath"] as const)(
    "bounds the final H workspace %s read before registering callback authority",
    async (phase) => {
      const f = await nativeFixture();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      workspaceFinalReadGate.phase = phase;
      workspaceFinalReadGate.entered = entered;
      workspaceFinalReadGate.release = new Promise<void>((resolve) => {
        release = resolve;
      });
      let consumed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const acquisition = withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          limits: {
            environment: { DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS: "2000" },
            hostFile: null,
            projectFile: null,
          },
        },
        async () => {
          consumed = true;
        },
      );
      const outcome = acquisition.then(
        () => "consumed",
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          reached,
          outcome.then(() => {
            throw new Error("H export settled before the final filesystem gate was reached.");
          }),
        ]);
        const observed = await Promise.race([
          outcome,
          new Promise<"still-pending">((resolve) => {
            timer = setTimeout(() => resolve("still-pending"), 5_000);
          }),
        ]);
        expect(observed).toMatchObject({
          code: "aggregate-timeout",
          evidence: {
            phase: "verification",
            quantity: { unit: "milliseconds", limit: "2000" },
          },
          limitRefusal: expect.stringContaining("repository-workspace-export-stall-ms-bound"),
        });
        expect(consumed).toBe(false);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        release();
        await outcome;
        workspaceFinalReadGate.phase = "";
        workspaceFinalReadGate.release = Promise.resolve();
      }
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "mints real callback custody and revokes its acquisition after settlement",
    async () => {
      const f = await nativeFixture();
      let context: Parameters<typeof createGithubPrCustody>[1] | undefined;
      let acquired: Parameters<typeof assertGithubPrObjectAcquisition>[0] | undefined;
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          acquired = basis.acquisition;
          context = {
            runId: "github-review-basis-run",
            requestSha256: createHash("sha256").update("request").digest("hex"),
            repository: {
              identitySha256: basis.headWorkspace.sourceIdentitySha256,
              revision: basis.headWorkspace.revision,
            },
            workspaceIdentitySha256: basis.headWorkspace.sourceIdentitySha256,
            repositoryContentDigest: basis.headInventory.inventorySha256,
            policy: createSourceStepPolicy({ sourceReadSkills: ["review-documentation"] }),
            observedAt: "2026-10-17T00:00:00.000Z",
          };
          const custody = await createGithubPrCustody(basis.acquisition, context);
          try {
            expect(custody.snapshot.graph).toMatchObject({ B: f.B, H: f.H, M: f.M });
            expect(custody.snapshot.sourceSides.some((side) => side.path === "docs/after.md")).toBe(
              true,
            );
          } finally {
            custody.dispose();
          }
          return undefined;
        },
      );
      expect(() => assertGithubPrObjectAcquisition(acquired!)).toThrow(
        "github-pr-acquisition-authority-required",
      );
      await expect(createGithubPrCustody(acquired!, context!)).rejects.toThrow(
        "github-pr-acquisition-authority-required",
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "revokes zero-side scoped authority and refuses post-return workspace reads",
    async () => {
      const f = await nativeFixture(true);
      let acquired: Parameters<typeof assertGithubPrObjectAcquisition>[0] | undefined;
      let workspace: unknown;
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          acquired = basis.acquisition;
          workspace = basis.headWorkspace;
          expect(basis.acquisition.sides).toEqual([]);
          expect(
            (
              await readTrackedRepositoryFile(basis.headWorkspace, "docs/unchanged.md", 1024)
            ).toString(),
          ).toBe("# Unchanged at H\n");
          return undefined;
        },
      );
      expect(() => assertGithubPrObjectAcquisition(acquired!)).toThrow();
      await expect(readTrackedRepositoryFile(workspace, "docs/unchanged.md", 1024)).rejects.toThrow(
        "not active",
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "closes admission with a live lease and defers removal until release",
    async () => {
      const f = await nativeFixture();
      let workspace: unknown;
      let release: (() => void) | undefined;
      await expect(
        withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
          },
          async (basis) => {
            workspace = basis.headWorkspace;
            release = await acquireRepositoryWorkspaceLease(basis.headWorkspace);
            await expect(basis.headWorkspace.dispose()).rejects.toThrow("leased");
            expect(
              (await readFile(join(basis.headWorkspace.path, "docs", "unchanged.md"))).toString(),
            ).toBe("# Unchanged at H\n");
            expect(await closeScopedRepositoryWorkspace(basis.headWorkspace)).toBe(false);
            return "consumer neglected lease";
          },
        ),
      ).rejects.toThrow("github-pr-workspace-lease-unsettled");
      expect(() => assertActiveRepositoryWorkspace(workspace)).toThrow("not active");
      const heldPath = (workspace as { path: string }).path;
      expect((await readFile(join(heldPath, "docs", "unchanged.md"))).toString()).toBe(
        "# Unchanged at H\n",
      );
      // Reader cleanup must be independent even while the workspace lease is unsettled.
      expect(await readdir(f.scratch)).toEqual([]);
      release!();
      expect(
        await closeScopedRepositoryWorkspace(
          workspace as Parameters<typeof closeScopedRepositoryWorkspace>[0],
        ),
      ).toBe(true);
      await waitForScopedRepositoryWorkspaceCleanup(
        workspace as Parameters<typeof waitForScopedRepositoryWorkspaceCleanup>[0],
      );
      await expect(readFile(join(heldPath, "docs", "unchanged.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    testTimeoutMs(120_000),
  );

  it(
    "retains one pending H disposal result across concurrent close and explicit cleanup wait",
    async () => {
      const f = await nativeFixture();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      scopedRemovalDelay.entered = entered;
      scopedRemovalDelay.release = held;
      let removedPath = "";
      try {
        await withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
          },
          async (basis) => {
            removedPath = join(basis.headWorkspace.path, "docs", "unchanged.md");
            scopedRemovalDelay.root = dirname(basis.headWorkspace.path);
            scopedRemovalDelay.active = true;
            const disposing = basis.headWorkspace.dispose();
            await reached;
            const closing = closeScopedRepositoryWorkspace(basis.headWorkspace);
            const waiting = waitForScopedRepositoryWorkspaceCleanup(basis.headWorkspace);
            let completed = false;
            void Promise.all([disposing, closing, waiting]).then(() => {
              completed = true;
            });
            await Promise.resolve();
            expect(completed).toBe(false);
            expect((await readFile(removedPath)).toString()).toBe("# Unchanged at H\n");
            release();
            await expect(disposing).resolves.toBeUndefined();
            await expect(closing).resolves.toBe(true);
            await expect(waiting).resolves.toBeUndefined();
            expect(completed).toBe(true);
            return "settled once";
          },
        );
        await expect(readFile(removedPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        release();
        scopedRemovalDelay.active = false;
        scopedRemovalDelay.root = "";
        scopedRemovalDelay.release = Promise.resolve();
      }
    },
    testTimeoutMs(120_000),
  );

  it.each(["provider", "consumer"] as const)(
    "retains an unleased workspace removal failure on a later scoped close (%s)",
    async (route) => {
      const f = await nativeFixture();
      let workspace: Parameters<typeof closeScopedRepositoryWorkspace>[0] | undefined;
      let workspaceRoot: string | undefined;
      scopedRemovalFault.root = "";
      scopedRemovalFault.injected = false;
      try {
        await expect(
          withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              apiFetch: f.apiFetch,
              objectFetch: f.objectFetch,
            },
            async (basis) => {
              workspace = basis.headWorkspace;
              workspaceRoot = dirname(basis.headWorkspace.path);
              scopedRemovalFault.root = workspaceRoot;
              if (route === "consumer")
                await expect(basis.headWorkspace.dispose()).rejects.toThrow(
                  "controlled-workspace-remove-failure",
                );
              return "consumer settled";
            },
          ),
        ).rejects.toThrow("controlled-workspace-remove-failure");
        expect(scopedRemovalFault.injected).toBe(true);
        expect(() => assertActiveRepositoryWorkspace(workspace)).toThrow("not active");
        await expect(closeScopedRepositoryWorkspace(workspace!)).rejects.toThrow(
          "controlled-workspace-remove-failure",
        );
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        scopedRemovalFault.root = "";
        if (workspaceRoot !== undefined)
          await filesystem.rm(workspaceRoot, { recursive: true, force: true });
      }
    },
    testTimeoutMs(120_000),
  );

  it.each([false, true])(
    "refuses late export abort after filesystem settlement (empty H: %s)",
    async (emptyHead) => {
      const f = await nativeFixture(false, false, emptyHead);
      const controller = new AbortController();
      const beforeRoots = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("docsfab-github-head-"),
      );
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        release = resolve;
      });
      workspaceLstatGate.active = true;
      workspaceLstatGate.fail = false;
      workspaceLstatGate.entered = entered;
      workspaceLstatGate.release = settled;
      let consumed = false;
      const registration = vi.spyOn(trackedWorkspaceReads, "registerRepositoryWorkspace");
      try {
        const acquisition = withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            signal: controller.signal,
          },
          async () => {
            consumed = true;
          },
        );
        await reached;
        controller.abort();
        release();
        await expect(acquisition).rejects.toThrow();
        expect(consumed).toBe(false);
        expect(registration).not.toHaveBeenCalled();
        expect(await readdir(f.scratch)).toEqual([]);
        expect(
          (await readdir(tmpdir())).filter((name) => name.startsWith("docsfab-github-head-")),
        ).toEqual(beforeRoots);
      } finally {
        release();
        registration.mockRestore();
        workspaceLstatGate.active = false;
        workspaceLstatGate.fail = false;
        workspaceLstatGate.release = Promise.resolve();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "retains export verification and failed-export cleanup errors together",
    async () => {
      const f = await nativeFixture();
      workspaceLstatGate.active = true;
      workspaceLstatGate.fail = true;
      workspaceLstatGate.entered = () => undefined;
      workspaceLstatGate.release = Promise.resolve();
      scopedRemovalFault.injected = false;
      let consumed = false;
      try {
        let failure: unknown;
        try {
          await withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              apiFetch: f.apiFetch,
              objectFetch: f.objectFetch,
            },
            async () => {
              consumed = true;
            },
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          expect.objectContaining({ message: "controlled-export-verification-failure" }),
          expect.objectContaining({ message: "controlled-workspace-remove-failure" }),
        ]);
        expect(consumed).toBe(false);
        expect(scopedRemovalFault.injected).toBe(true);
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        workspaceLstatGate.active = false;
        workspaceLstatGate.fail = false;
        const failedRoot = scopedRemovalFault.root;
        scopedRemovalFault.root = "";
        if (failedRoot !== "") {
          // The controlled failure intentionally left this owned temp root behind.
          await filesystem.rm(failedRoot, { recursive: true, force: true });
        }
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "retains both callback and workspace-close failures while independently cleaning the reader",
    async () => {
      const f = await nativeFixture();
      let workspace: { dispose(): Promise<void> } | undefined;
      let closeCalled = false;
      const close = vi
        .spyOn(trackedWorkspaceReads, "closeScopedRepositoryWorkspace")
        .mockImplementationOnce(async () => {
          closeCalled = true;
          throw new Error("controlled-workspace-close-failure");
        });
      try {
        let caught: unknown;
        try {
          await withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              apiFetch: f.apiFetch,
              objectFetch: f.objectFetch,
            },
            async (basis) => {
              workspace = basis.headWorkspace;
              expect(
                (await readTrackedRepositoryFile(basis.headWorkspace, "docs/unchanged.md", 1024))
                  .length,
              ).toBeGreaterThan(0);
              throw new Error("controlled-callback-failure");
            },
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).errors).toEqual([
          expect.objectContaining({ message: "controlled-callback-failure" }),
          expect.objectContaining({ message: "controlled-workspace-close-failure" }),
        ]);
        expect(closeCalled).toBe(true);
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        close.mockRestore();
        await workspace?.dispose();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "closes the registered workspace if genuine H inventory construction fails before callback",
    async () => {
      const f = await nativeFixture();
      const beforeRoots = (await readdir(tmpdir()))
        .filter((name) => name.startsWith("docsfab-github-head-"))
        .sort();
      let consumed = false;
      const inventory = vi
        .spyOn(repositoryInventory, "buildRepositoryDiscoveryInventory")
        .mockRejectedValueOnce(new Error("controlled-inventory-failure"));
      try {
        await expect(
          withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              apiFetch: f.apiFetch,
              objectFetch: f.objectFetch,
            },
            async () => {
              consumed = true;
            },
          ),
        ).rejects.toThrow("controlled-inventory-failure");
        expect(consumed).toBe(false);
        expect(await readdir(f.scratch)).toEqual([]);
        expect(
          (await readdir(tmpdir()))
            .filter((name) => name.startsWith("docsfab-github-head-"))
            .sort(),
        ).toEqual(beforeRoots);
      } finally {
        inventory.mockRestore();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a tighter H entry ceiling at the first excess entry without clipping inventory",
    async () => {
      const f = await nativeFixture();
      const entries = git(f.root, f.work, "ls-tree", "-r", "--name-only", f.H).split("\n").length;
      const limits = (maximum: number) => ({
        environment: {
          DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_ENTRIES: String(maximum),
        },
        hostFile: null,
        projectFile: null,
      });
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          limits: limits(entries),
        },
        async (basis) => {
          expect((await listTrackedRepositoryEntries(basis.headWorkspace)).length).toBe(entries);
          return undefined;
        },
      );
      await expect(
        withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            limits: limits(entries - 1),
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "repository-workspace-export-max-tree-entries-bound" });
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses external abort after inventory but before callback admission",
    async () => {
      const f = await nativeFixture();
      const controller = new AbortController();
      const original = repositoryInventory.buildRepositoryDiscoveryInventory;
      const inventory = vi
        .spyOn(repositoryInventory, "buildRepositoryDiscoveryInventory")
        .mockImplementationOnce(async (options) => {
          const result = await original(options);
          controller.abort();
          return result;
        });
      let consumed = false;
      try {
        await expect(
          withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              apiFetch: f.apiFetch,
              objectFetch: f.objectFetch,
              signal: controller.signal,
            },
            async () => {
              consumed = true;
            },
          ),
        ).rejects.toThrow();
        expect(controller.signal.aborted).toBe(true);
        expect(consumed).toBe(false);
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        inventory.mockRestore();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "preserves the catalog acquisition deadline at the late H filesystem gate",
    async () => {
      const f = await nativeFixture();
      const beforeRoots = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("docsfab-github-head-"),
      );
      const realNow = performance.now.bind(performance);
      const deadline = limit("changeSourcesGithub.acquisitionTimeoutMs").value;
      let expired = false;
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      workspaceLstatGate.active = true;
      workspaceLstatGate.fail = false;
      workspaceLstatGate.entered = () => {
        expired = true;
        entered();
      };
      workspaceLstatGate.release = new Promise<void>((resolve) => {
        release = resolve;
      });
      const clock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => realNow() + (expired ? deadline + 1 : 0));
      const registration = vi.spyOn(trackedWorkspaceReads, "registerRepositoryWorkspace");
      let consumed = false;
      try {
        const acquisition = withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            limits: {
              environment: { DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS: "600000" },
              hostFile: null,
              projectFile: null,
            },
          },
          async () => {
            consumed = true;
          },
        );
        void acquisition.catch(() => undefined);
        await reached;
        release();
        await expect(acquisition).rejects.toMatchObject({
          code: "change-source-github-acquisition-timeout",
          limitName: "changeSourcesGithub.acquisitionTimeoutMs",
          configured: deadline,
          unit: "ms",
          message: expect.stringContaining("Retry when GitHub and the local host are responsive"),
        });
        expect(expired).toBe(true);
        expect(consumed).toBe(false);
        expect(registration).not.toHaveBeenCalled();
        expect(await readdir(f.scratch)).toEqual([]);
        expect(
          (await readdir(tmpdir())).filter((name) => name.startsWith("docsfab-github-head-")),
        ).toEqual(beforeRoots);
      } finally {
        release();
        registration.mockRestore();
        clock.mockRestore();
        workspaceLstatGate.active = false;
        workspaceLstatGate.fail = false;
        workspaceLstatGate.release = Promise.resolve();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses an acquisition deadline that expires after H inventory but before callback admission",
    async () => {
      const f = await nativeFixture();
      const original = repositoryInventory.buildRepositoryDiscoveryInventory;
      const realNow = performance.now.bind(performance);
      const deadline = limit("changeSourcesGithub.acquisitionTimeoutMs").value;
      let expired = false;
      const clock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => realNow() + (expired ? deadline + 1 : 0));
      const inventory = vi
        .spyOn(repositoryInventory, "buildRepositoryDiscoveryInventory")
        .mockImplementationOnce(async (options) => {
          const result = await original(options);
          expired = true;
          return result;
        });
      let consumed = false;
      try {
        await expect(
          withGithubPrReviewBasis(
            "https://github.com/target/docs/pull/884",
            {
              workspaceRoot: f.work,
              scratchRoot: f.scratch,
              apiFetch: f.apiFetch,
              objectFetch: f.objectFetch,
            },
            async () => {
              consumed = true;
            },
          ),
        ).rejects.toMatchObject({ code: "change-source-github-acquisition-timeout" });
        expect(expired).toBe(true);
        expect(consumed).toBe(false);
        expect(await readdir(f.scratch)).toEqual([]);
      } finally {
        inventory.mockRestore();
        clock.mockRestore();
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "awaits an already-started cooperative callback before removing its private reader",
    async () => {
      const f = await nativeFixture();
      const controller = new AbortController();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let settled = false;
      const run = withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          signal: controller.signal,
        },
        async (basis) => {
          expect(
            (await readTrackedRepositoryFile(basis.headWorkspace, "docs/unchanged.md", 1024))
              .length,
          ).toBeGreaterThan(0);
          entered();
          await held;
          settled = true;
          return "cooperative callback completed";
        },
      );
      try {
        await reached;
        controller.abort();
        expect((await readdir(f.scratch)).length).toBeGreaterThan(0);
      } finally {
        release();
      }
      expect(await run).toBe("cooperative callback completed");
      expect(settled).toBe(true);
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "awaits cooperative callback abort and independently cleans reader after consumer failure",
    async () => {
      const f = await nativeFixture();
      const controller = new AbortController();
      let callbackSettled = false;
      await expect(
        withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch: f.objectFetch,
            signal: controller.signal,
          },
          async (basis) => {
            expect(
              (await readTrackedRepositoryFile(basis.headWorkspace, "docs/unchanged.md", 1024))
                .length,
            ).toBeGreaterThan(0);
            controller.abort();
            expect(basis.signal.aborted).toBe(true);
            await Promise.resolve();
            callbackSettled = true;
            throw new Error("cooperative-consumer-stop");
          },
        ),
      ).rejects.toThrow("cooperative-consumer-stop");
      expect(callbackSettled).toBe(true);
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "cancels H-only blob acquisition without retaining private Git",
    async () => {
      const f = await nativeFixture();
      const controller = new AbortController();
      const objectFetch = async (url: string, init: RequestInit) => {
        if (init.method === "POST" && Buffer.from(init.body as Buffer).includes(f.unchangedBlob))
          controller.abort();
        return f.objectFetch(url, init);
      };
      await expect(
        withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch,
            signal: controller.signal,
          },
          async () => undefined,
        ),
      ).rejects.toThrow();
      expect(controller.signal.aborted).toBe(true);
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "registers an empty H tree without leaking scoped authority after return",
    async () => {
      const f = await nativeFixture(false, false, true);
      let acquired: Parameters<typeof assertGithubPrObjectAcquisition>[0] | undefined;
      const result = await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          acquired = basis.acquisition;
          expect(await listTrackedRepositoryEntries(basis.headWorkspace)).toEqual([]);
          expect(basis.headInventory.repositoryRevision).toBe(f.H);
          expect(basis.headWorkspace.headTree).toBe(f.headTree);
          expect(basis.baseDocumentation.entries.length).toBeGreaterThan(0);
          return "empty H admitted";
        },
      );
      expect(result).toBe("empty H admitted");
      expect(() => assertGithubPrObjectAcquisition(acquired!)).toThrow(
        "github-pr-acquisition-authority-required",
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "revokes an authentic verified-tree port when its private reader is disposed",
    async () => {
      const f = await nativeFixture();
      const reader = await createGithubPrObjectReader(
        {
          target: { owner: "target", repo: "docs", repositoryId: 10 },
          headRepository: { owner: "fork", repo: "docs", repositoryId: 11 },
          baseTip: f.B,
          headTip: f.H,
          workspaceRoot: f.work,
        },
        { scratchRoot: f.scratch, fetchPort: f.objectFetch },
      );
      let port: GithubPrVerifiedTreeExportPort;
      try {
        await reader.acquireTips();
        await reader.resolveGraph();
        await reader.acquireTreesAndBlobs();
        port = await reader.exportVerifiedHeadTree();
        assertGithubPrVerifiedTreeExportPort(port);
        expect(port.manifestSha256).toBe(canonicalDigest(await reader.enumerate()));
        await expect(
          prepareRepositoryWorkspaceFromVerifiedTree(port, {
            sourceIdentitySha256: "a".repeat(64),
            manifestSha256: port.manifestSha256,
          }),
        ).rejects.toThrow("verified GitHub PR head workspace identity is invalid");
        await expect(
          prepareRepositoryWorkspaceFromVerifiedTree(port, {
            sourceIdentitySha256: port.sourceIdentitySha256,
            manifestSha256: "b".repeat(64),
          }),
        ).rejects.toThrow("verified GitHub PR head workspace identity is invalid");
      } finally {
        await reader.dispose();
      }
      expect(() => assertGithubPrVerifiedTreeExportPort(port!)).toThrow(
        "github-pr-verified-tree-authority-required",
      );
      await expect(
        prepareRepositoryWorkspaceFromVerifiedTree(port!, {
          sourceIdentitySha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
        }),
      ).rejects.toThrow("github-pr-verified-tree-authority-required");
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "exports many authenticated H entries without repeated full-tree path scans",
    async () => {
      const f = await nativeFixture(false, false, false, false, 24);
      const reader = await createGithubPrObjectReader(
        {
          target: { owner: "target", repo: "docs", repositoryId: 10 },
          headRepository: { owner: "fork", repo: "docs", repositoryId: 11 },
          baseTip: f.B,
          headTip: f.H,
          workspaceRoot: f.work,
        },
        { scratchRoot: f.scratch, fetchPort: f.objectFetch },
      );
      let workspace:
        | Awaited<ReturnType<typeof prepareRepositoryWorkspaceFromVerifiedTree>>
        | undefined;
      try {
        await reader.acquireTips();
        await reader.resolveGraph();
        await reader.acquireTreesAndBlobs();
        const port = await reader.exportVerifiedHeadTree();
        const original = port.headEntries.find((entry) => entry.path === "docs/unchanged.md");
        expect(original).toBeDefined();
        await expect(port.readVerifiedBlob({ ...original! })).rejects.toMatchObject({
          code: "github-pr-verified-blob-authority-required",
        });
        const regularCount = port.headEntries.filter(
          (entry) => entry.mode === "100644" || entry.mode === "100755",
        ).length;
        expect(regularCount).toBeGreaterThan(24);
        const originalFind = Array.prototype.find;
        let inspectedEntries = 0;
        const findSpy = vi.spyOn(Array.prototype, "find").mockImplementation(function (
          this: unknown[],
          predicate: (value: unknown, index: number, array: unknown[]) => unknown,
          thisArg?: unknown,
        ) {
          if (this !== port.headEntries)
            return Reflect.apply(originalFind, this, [predicate, thisArg]);
          return Reflect.apply(originalFind, this, [
            (value: unknown, index: number, array: unknown[]) => {
              inspectedEntries += 1;
              return Reflect.apply(predicate, thisArg, [value, index, array]);
            },
            thisArg,
          ]);
        });
        try {
          workspace = await prepareRepositoryWorkspaceFromVerifiedTree(port, {
            sourceIdentitySha256: port.sourceIdentitySha256,
            manifestSha256: port.manifestSha256,
          });
        } finally {
          findSpy.mockRestore();
        }
        expect(inspectedEntries).toBeLessThanOrEqual(port.headEntries.length * 2);
        const exact = await readTrackedRepositoryFile(workspace, "docs/unchanged.md", 1024);
        expect(exact.toString("utf8")).toBe("# Unchanged at H\n");
        expect(
          createHash("sha1").update(`blob ${exact.length}\0`).update(exact).digest("hex"),
        ).toBe(f.unchangedBlob);
      } finally {
        await workspace?.dispose();
        await reader.dispose();
      }
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it("refuses a plain serialized tree port before any workspace registration", async () => {
    const forged = {
      sourcePath: "/not-a-reader",
      targetRepositoryId: 10,
      headRepositoryId: 11,
      B: "a".repeat(40),
      H: "b".repeat(40),
      M: "c".repeat(40),
      baseTree: "d".repeat(40),
      headTree: "e".repeat(40),
      headEntries: [],
      baseDocumentation: [],
      readVerifiedBlob: async () => Buffer.alloc(0),
      cancel: () => {},
    } as unknown as GithubPrVerifiedTreeExportPort;
    await expect(
      prepareRepositoryWorkspaceFromVerifiedTree(forged, {
        sourceIdentitySha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
      }),
    ).rejects.toThrow("github-pr-verified-tree-authority-required");
  });

  it(
    "preserves NFC/NFD Git identities or refuses an actual host alias collision",
    async () => {
      const f = await nativeFixture(false, true);
      const gitNames = git(f.root, f.work, "ls-tree", "-rz", "--name-only", f.H).split("\0");
      expect(gitNames).toContain("docs/é.md");
      expect(gitNames).toContain("docs/é.md");
      const beforeRoots = (await readdir(tmpdir()))
        .filter((name) => name.startsWith("docsfab-github-head-"))
        .sort();
      const probe = join(f.root, "filesystem-probe");
      await mkdir(probe);
      await writeFile(join(probe, "é"), "one", { flag: "wx" });
      let aliases = false;
      try {
        await writeFile(join(probe, "é"), "two", { flag: "wx" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        aliases = true;
      }
      let callbackReached = false;
      const attempt = withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
        },
        async (basis) => {
          callbackReached = true;
          expect(
            (await readTrackedRepositoryFile(basis.headWorkspace, "docs/é.md", 1024)).toString(),
          ).toBe("# Unicode at H\n");
          expect(
            (await readTrackedRepositoryFile(basis.headWorkspace, "docs/é.md", 1024)).toString(),
          ).toBe("# Unicode at H\n");
          return "distinct";
        },
      );
      if (aliases) {
        await expect(attempt).rejects.toMatchObject({ code: "filesystem-path-collision" });
        expect(callbackReached).toBe(false);
      } else expect(await attempt).toBe("distinct");
      expect(await readdir(f.scratch)).toEqual([]);
      expect(
        (await readdir(tmpdir())).filter((name) => name.startsWith("docsfab-github-head-")).sort(),
      ).toEqual(beforeRoots);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a PR that changes after H export and never calls the consumer",
    async () => {
      const f = await nativeFixture();
      let pullReads = 0;
      let consumed = false;
      const apiFetch = async (url: string, init: RequestInit) => {
        const response = await f.apiFetch(url, init);
        if (!new URL(url).pathname.endsWith("/pulls/884")) return response;
        pullReads += 1;
        if (pullReads !== 3) return response;
        const body = (await response.json()) as { head: { sha: string } };
        body.head.sha = f.B;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      await expect(
        withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch,
            objectFetch: f.objectFetch,
          },
          async () => {
            consumed = true;
          },
        ),
      ).rejects.toThrow("github-pr-metadata-drift");
      expect(pullReads).toBe(3);
      expect(consumed).toBe(false);
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses an unavailable unchanged H blob without a registered workspace",
    async () => {
      const f = await nativeFixture();
      let consumed = false;
      let missingRequested = false;
      const objectFetch = async (url: string, init: RequestInit) => {
        if (init.method === "POST" && Buffer.from(init.body as Buffer).includes(f.unchangedBlob)) {
          missingRequested = true;
          return new Response("object unavailable", { status: 503 });
        }
        return f.objectFetch(url, init);
      };
      await expect(
        withGithubPrReviewBasis(
          "https://github.com/target/docs/pull/884",
          {
            workspaceRoot: f.work,
            scratchRoot: f.scratch,
            apiFetch: f.apiFetch,
            objectFetch,
          },
          async () => {
            consumed = true;
          },
        ),
      ).rejects.toThrow();
      expect(missingRequested).toBe(true);
      expect(consumed).toBe(false);
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "charges exact H regular bytes at the aggregate limit and refuses the next byte",
    async () => {
      const f = await nativeFixture();
      const paths = ["docs/unchanged.md", "docs/before.md", "docs/after.md", "docs/é.md"];
      const exact = paths.reduce(
        (sum, path) => sum + Number(git(f.root, f.work, "cat-file", "-s", `${f.H}:${path}`)),
        0,
      );
      const limits = (maximum: number) => ({
        environment: {
          DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_AGGREGATE_BYTES: String(maximum),
        },
        hostFile: null,
        projectFile: null,
      });
      await withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          limits: limits(exact),
        },
        async (basis) => {
          expect(
            (await readTrackedRepositoryFile(basis.headWorkspace, "docs/unchanged.md", 1024))
              .length,
          ).toBeGreaterThan(0);
          return undefined;
        },
      );
      const over = withGithubPrReviewBasis(
        "https://github.com/target/docs/pull/884",
        {
          workspaceRoot: f.work,
          scratchRoot: f.scratch,
          apiFetch: f.apiFetch,
          objectFetch: f.objectFetch,
          limits: limits(exact - 1),
        },
        async () => undefined,
      );
      await expect(over).rejects.toMatchObject({
        code: "aggregate-byte-limit",
        evidence: {
          phase: "preflight",
          quantity: { unit: "bytes", limit: String(exact - 1), observed: String(exact) },
        },
      });
      await expect(over).rejects.toThrow("repository-workspace-export-max-aggregate-bytes-bound");
      await expect(over).rejects.toThrow(
        "Raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_AGGREGATE_BYTES",
      );
      expect(await readdir(f.scratch)).toEqual([]);
    },
    testTimeoutMs(120_000),
  );
});
