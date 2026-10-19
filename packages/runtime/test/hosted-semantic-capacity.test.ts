// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exact maintained source bytes; approvals/model semantics are deliberately synthetic. */
import { execFileSync, spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import {
  digest,
  sealHostRuntimeSemanticComparisonChunk,
  sealHostRuntimeComposition,
  parseHostRuntimeRequest,
  canonicalJson,
} from "../src/host-invoker/contracts.js";
import { readHostRuntimeRequest } from "../src/host-invoker/main.js";
import { inspectHostedWorkflowCatalog } from "../src/host-invoker/workflow-catalog.js";
import {
  HOSTED_INPUT_CAPACITY,
  HOSTED_REQUEST_MAXIMUM_BYTES,
  SEMANTIC_INPUT_CAPACITY,
  hostedRequestMaximumBytes,
} from "../src/live-agent/input-capacity.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { createHash } from "node:crypto";
import { internalOnly } from "./helpers/internal-path.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const paths = [
  "planning/plan-of-record.md",
  "planning/product-requirements.md",
  "planning/software-requirements.md",
  "docs/about/core-concepts/product-knowledge.md",
];
const MODEL_PATH = ".docsfab/reference-model/shared/DOCSFAB-PRODUCT/v0.28/model.md";
const maintainedSources = internalOnly(
  [...paths.filter((path) => path.startsWith("planning/")), MODEL_PATH],
  "it reads internal planning and reference-model documents at their real sizes, which are not exported",
);
it.each(["schema-refusal", "already-aborted", "abort-after-start"] as const)(
  "preserves borrowed regular-file identity and position after %s",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-semantic-file-custody-"));
    const path = join(root, "request.json");
    const prefix = "already-read:";
    await writeFile(path, `${prefix}{}`);
    const handle = await open(path, "r");
    try {
      const identity = await handle.stat();
      await handle.read(Buffer.alloc(prefix.length), 0, prefix.length, null);
      // A reopened pathname would select another object and reset the cursor.
      await rename(path, join(root, "original.json"));
      await writeFile(path, "replacement");
      const controller = new AbortController();
      if (phase === "already-aborted") controller.abort();
      const pending = readHostRuntimeRequest(handle.fd, controller.signal);
      if (phase === "abort-after-start") controller.abort();
      if (phase === "schema-refusal") await expect(pending).rejects.toThrow();
      else await expect(pending).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      const retained = await handle.stat();
      expect({ dev: retained.dev, ino: retained.ino }).toEqual({
        dev: identity.dev,
        ino: identity.ino,
      });
      const next = await handle.read(Buffer.alloc(1), 0, 1, null);
      if (phase === "already-aborted") {
        expect(next.bytesRead).toBe(1);
        expect(next.buffer.toString("utf8")).toBe("{");
      } else expect(next.bytesRead).toBe(0);
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(maintainedSources.skip).each([2, 8])(
  maintainedSources.title(
    "reads complete real four-document input with %s retained source aliases through the actual worker fd and Git proof",
  ),
  async (aliases) => {
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const git = (...args: string[]) =>
      execFileSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
    const revision = git("rev-parse", "HEAD"),
      sourceTreeObjectId = git("rev-parse", "HEAD^{tree}");
    const documents = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [path, await readFile(join(repository, path), "utf8")]),
      ),
    );
    const modelPath = MODEL_PATH,
      model = await readFile(join(repository, modelPath), "utf8");
    const evidence = Array.from({ length: aliases }, (_, alias) =>
      paths.map((path, index) => ({
        evidenceId: `source-alias-${alias}-${index}`,
        kind: "supporting-context" as const,
        version: revision,
        sourcePath: path,
        change: "context" as const,
        content: documents[path]!,
        contentSha256: sha(documents[path]!),
        sourceContentSha256: sha(documents[path]!),
        startByte: 0,
        endByte: Buffer.byteLength(documents[path]!),
        totalBytes: Buffer.byteLength(documents[path]!),
        sourceVersionSha256: sha("fixture-source-version"),
        repositoryRole: {
          sourceKind:
            index === 3
              ? ("repository-documentation" as const)
              : (["por", "prd", "srd"][index] as "por" | "prd" | "srd"),
          classification: "context" as const,
          coveragePlanSha256: sha("fixture-coverage"),
        },
      })),
    ).flat();
    const chunk = sealHostRuntimeSemanticComparisonChunk(
      {
        schemaVersion: 1,
        kind: "docsfab-semantic-comparison-chunk",
        projectId: "project-fixture",
        caseKind: "source-case",
        caseSha256: sha("case"),
        comparisonSha256: sha("comparison"),
        baselineGeneration: 1,
        baselineSha256: sha("baseline"),
        approvalReceiptSha256: sha("approval"),
        modelSha256: sha(model),
        canonSha256: sha(model),
        sourceInventorySha256: sha("inventory"),
        ordinal: 1,
        chunkCount: 1,
        repositoryObservationVersion: 3,
        claims: [
          {
            claimId: "CLAIM-CAPACITY",
            statement: "Retain complete source evidence.",
            statementSha256: sha("Retain complete source evidence."),
            scope: "synthetic capacity control",
            recordSha256: sha("claim"),
          },
        ],
        evidence,
      },
      (item) => documents[item.sourcePath!],
    );
    expect(Buffer.byteLength(canonicalJson(chunk))).toBeGreaterThan(131072);
    const catalog = inspectHostedWorkflowCatalog("reconcile-product-behavior"),
      capsule = {
        receiptSha256: sha("capsule"),
        expiresAt: "2099-01-01T00:00:00.000Z",
        selectedEvidence: [],
      };
    const root = await mkdtemp(join(tmpdir(), "docsfab-semantic-capacity-"));
    try {
      const request = parseHostRuntimeRequest({
        schemaVersion: 1,
        kind: "docsfab-host-runtime-request",
        deploymentId: "deployment-fixture",
        projectId: "project-fixture",
        deploymentEpoch: "epoch-fixture",
        requestKey: "semantic-capacity",
        origin: { principalId: "fixture-owner", requestId: "capacity" },
        runId: "capacity-run",
        fence: 1,
        workflow: catalog.workflow,
        revision,
        sourceTreeObjectId,
        packet: {
          packetFingerprintSha256: digest(chunk.inputSha256),
          inputManifest: null,
          canon: {
            kind: "canon",
            sha256: sha(model),
            sourcePathSha256: sha(modelPath),
            gitObjectId: git("rev-parse", `HEAD:${modelPath}`),
            content: model,
          },
          reviewEvent: null,
          semanticComparison: chunk,
        },
        stepIds: catalog.stepIds,
        toolPolicySha256: digest({
          workflow: catalog.workflow,
          stepIds: catalog.stepIds,
          declaredTools: catalog.declaredTools,
        }),
        workspacePath: repository,
        stateDirectory: root,
        capsule: { ...capsule, sha256: digest(capsule) },
        composition: sealHostRuntimeComposition({
          compositionId: "capacity-fixture",
          route: "offline-fixture",
          credentialFamily: "none",
          executionProfile: null,
          declaredTools: catalog.declaredTools,
        }),
        allowWrite: false,
      });
      const wire = JSON.stringify(request);
      if (aliases === 8)
        expect(Buffer.byteLength(wire)).toBeGreaterThan(HOSTED_INPUT_CAPACITY.ordinaryRequestBytes);
      const path = join(root, "request.json");
      await writeFile(path, wire);
      const handle = await open(path, "r");
      try {
        const read = await readHostRuntimeRequest(handle.fd);
        expect(canonicalJson(read)).toBe(canonicalJson(request));
        expect(read.packet.semanticComparison!.evidence).toHaveLength(aliases * 4);
        expect((await handle.stat()).isFile()).toBe(true);
      } finally {
        await handle.close();
      }
      expect(await readThroughOwnedPipe(wire)).toEqual({
        requestSha256: digest(request),
        evidenceCount: aliases * 4,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  testTimeoutMs(30_000),
);

/** The transferred pipe reaches actual EOF after every serialized request byte. */
async function readThroughOwnedPipe(wire: string) {
  const mainUrl = new URL("../src/host-invoker/main.ts", import.meta.url).href;
  const contractsUrl = new URL("../src/host-invoker/contracts.ts", import.meta.url).href;
  const code = `
    const { readHostRuntimeRequest } = await import(${JSON.stringify(mainUrl)});
    const { digest } = await import(${JSON.stringify(contractsUrl)});
    const request = await readHostRuntimeRequest(3);
    process.stdout.write(JSON.stringify({
      requestSha256: digest(request), evidenceCount: request.packet.semanticComparison.evidence.length,
    }));
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, PI_OFFLINE: "1" },
  });
  let output = "";
  child.stdout!.on("data", (bytes: Buffer) => {
    output += bytes.toString("utf8");
  });
  child.stderr!.resume();
  const input = child.stdio[3] as import("node:stream").Writable;
  return await new Promise<{ requestSha256: string; evidenceCount: number }>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new Error("Hosted pipe reader did not finish after EOF."));
      },
      nestedDeadlineMs(15_000, 30_000),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    input.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      input.destroy();
      if (status !== 0) return reject(new Error("Hosted pipe reader refused its complete input."));
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
    input.end(wire);
  });
}

/**
 * The semantic wire ceiling is a registered bound, not a multiple of the chunk
 * allowance computed at import. It is also `HOSTED_REQUEST_MAXIMUM_BYTES`, the
 * pre-parse `readBoundedFd` ceiling every workflow's descriptor is read under.
 */
it("registers the semantic request ceiling and keeps the ordinary ceilings distinct", () => {
  const registered = LIMIT_DEFINITION_BY_NAME["semantic.comparisonRequestBytes"];
  expect(registered, "semantic.comparisonRequestBytes must be a catalog entry").toBeDefined();
  // JSON's longest encoding of one source byte, measured rather than restated.
  const worstCaseEscapedBytesPerSourceByte =
    Buffer.byteLength(JSON.stringify("\u0000")) - Buffer.byteLength(JSON.stringify(""));
  const chunk = LIMIT_DEFINITION_BY_NAME["semantic.comparisonChunkBytes"]!;
  expect(registered!.max).toBe(
    HOSTED_INPUT_CAPACITY.ordinaryRequestBytes +
      worstCaseEscapedBytesPerSourceByte * chunk.max -
      HOSTED_INPUT_CAPACITY.ordinaryFrozenInputsBytes,
  );
  expect(registered!.value).toBe(registered!.max);
  expect(SEMANTIC_INPUT_CAPACITY.requestBytes).toBe(registered!.max);
  expect(hostedRequestMaximumBytes("reconcile-product-behavior")).toBe(registered!.max);
  expect(HOSTED_REQUEST_MAXIMUM_BYTES).toBe(registered!.max);
  // Adjacent workflows the semantic ceiling must not widen.
  expect(hostedRequestMaximumBytes("live-agent-turn")).toBe(HOSTED_INPUT_CAPACITY.requestBytes);
  expect(hostedRequestMaximumBytes("readiness")).toBe(HOSTED_INPUT_CAPACITY.ordinaryRequestBytes);
  expect(hostedRequestMaximumBytes("readiness")).toBeLessThan(registered!.max);
});

const ORDINARY_CANON = "Ordinary workflows still carry one frozen input.\n";

/** JSON tolerates trailing whitespace, so padding keeps the request valid and
 * makes the serialized byte count exact: the size gate is the only variable. */
function ordinaryRequestWire(root: string, repository: string): string {
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  const catalog = inspectHostedWorkflowCatalog("readiness");
  const capsule = {
    receiptSha256: sha("capsule"),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [],
  };
  const request = parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "deployment-fixture",
    projectId: "project-fixture",
    deploymentEpoch: "epoch-fixture",
    requestKey: "ordinary-capacity",
    origin: { principalId: "fixture-owner", requestId: "capacity" },
    runId: "capacity-run",
    fence: 1,
    workflow: catalog.workflow,
    revision: git("rev-parse", "HEAD"),
    sourceTreeObjectId: git("rev-parse", "HEAD^{tree}"),
    packet: {
      packetFingerprintSha256: sha("ordinary-packet"),
      inputManifest: null,
      canon: {
        kind: "canon",
        sha256: sha(ORDINARY_CANON),
        sourcePathSha256: sha("docs/model.md"),
        gitObjectId: "a".repeat(40),
        content: ORDINARY_CANON,
      },
      reviewEvent: null,
    },
    stepIds: catalog.stepIds,
    toolPolicySha256: digest({
      workflow: catalog.workflow,
      stepIds: catalog.stepIds,
      declaredTools: catalog.declaredTools,
    }),
    workspacePath: repository,
    stateDirectory: root,
    capsule: { ...capsule, sha256: digest(capsule) },
    composition: sealHostRuntimeComposition({
      compositionId: "capacity-fixture",
      route: "offline-fixture",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools: catalog.declaredTools,
    }),
    allowWrite: false,
  });
  return JSON.stringify(request);
}

it.each([0, 1])(
  "reads an ordinary workflow descriptor at its per-workflow ceiling plus %s",
  async (excess) => {
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const root = await mkdtemp(join(tmpdir(), "docsfab-ordinary-capacity-"));
    try {
      const ceiling = hostedRequestMaximumBytes("readiness");
      // The semantic entry sets the pre-parse ceiling; an ordinary workflow is
      // still refused at its own, far smaller, bound.
      expect(ceiling).toBeLessThan(HOSTED_REQUEST_MAXIMUM_BYTES);
      const body = ordinaryRequestWire(root, repository);
      const fill = ceiling + excess - Buffer.byteLength(body);
      expect(fill, "fixture request must be smaller than the ordinary ceiling").toBeGreaterThan(0);
      const wire = body + " ".repeat(fill);
      expect(Buffer.byteLength(wire)).toBe(ceiling + excess);
      const path = join(root, "request.json");
      await writeFile(path, wire);
      const handle = await open(path, "r");
      try {
        const pending = readHostRuntimeRequest(handle.fd);
        if (excess === 0) expect((await pending).workflow).toBe("readiness");
        else
          await expect(pending).rejects.toThrow(
            `host-invoker-request-max-bytes-bound: ${ceiling + excess} exceeds the readiness serialized request capacity of ${ceiling} bytes.`,
          );
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  testTimeoutMs(30_000),
);
