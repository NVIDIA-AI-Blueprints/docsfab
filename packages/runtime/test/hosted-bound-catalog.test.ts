// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalogued hosted-runtime representation capacities, at the limit and at the
 * limit plus one. Fixtures are sized from `config/limits.yaml` through
 * `limitDefinition(...).max`, not typed literals, so a re-hardcoded parser
 * bound fails here even when the numbers agree today.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nestedDeadlineMs } from "./helpers/test-timeouts.js";

import { catalogCapacity } from "../src/config/catalog-capacity.js";
import { limitDefinition } from "../src/config/limits.js";
import { REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT } from "../src/execution/contracts.js";
import {
  digest,
  parseHostRuntimePatchEvidence,
  parseHostRuntimeRequest,
  parseHostRuntimeTerminal,
  sealHostRuntimeComposition,
  sealHostRuntimePatchEvidence,
  sealHostRuntimeWriteAuthority,
  type HostRuntimePatchChangeV1,
  type HostRuntimeWriteAuthorityV2,
} from "../src/host-invoker/contracts.js";
import { MAX_REPLAY_RECORD_BYTES } from "../src/host-invoker/main.js";
import { HOSTED_OUTPUT_LINE_MAXIMUM_BYTES } from "../src/host-invoker/output-capacity.js";
import { decodeRunEditorialOutcomeV1 } from "../src/host-invoker/terminal.js";
import { inspectHostedWorkflowCatalog } from "../src/host-invoker/workflow-catalog.js";

const capacity = (name: string): number => limitDefinition(name).max;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const WORKFLOW = "readiness" as const;
/** A hosted workflow that may carry a focused review scope. */
const REVIEW_WORKFLOW = "review-documentation" as const;
const CATALOG = inspectHostedWorkflowCatalog(WORKFLOW);
const REVIEW_CATALOG = inspectHostedWorkflowCatalog(REVIEW_WORKFLOW);
const compositionFor = (declaredTools: readonly string[]) =>
  sealHostRuntimeComposition({
    compositionId: "bound-catalog-fixture",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools,
  });
const COMPOSITION = compositionFor(CATALOG.declaredTools);
const REVIEW_COMPOSITION = compositionFor(REVIEW_CATALOG.declaredTools);
const MANIFEST_CONTENT = '{"schemaVersion":1,"kind":"fixture-input"}\n';

interface RequestParts {
  stepIds?: readonly string[];
  selectedEvidence?: readonly { evidenceId: string; content: string }[];
  reviewScope?: unknown;
}

/**
 * The wire shape the host dispatcher writes to the worker's request descriptor,
 * built as plain data so one field at a time can be driven to its capacity.
 */
function hostedRequest(parts: RequestParts = {}): Record<string, unknown> {
  const scoped = parts.reviewScope !== undefined;
  const workflow = scoped ? REVIEW_WORKFLOW : WORKFLOW;
  const composition = scoped ? REVIEW_COMPOSITION : COMPOSITION;
  const stepIds = parts.stepIds ?? (scoped ? REVIEW_CATALOG.stepIds : CATALOG.stepIds);
  const selectedEvidence = parts.selectedEvidence ?? [
    { evidenceId: "approved-context", content: "Assess the bound repository." },
  ];
  const capsuleBody = {
    receiptSha256: "d".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: selectedEvidence.map((entry) => ({
      evidenceId: entry.evidenceId,
      content: entry.content,
    })),
  };
  return {
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "fixture",
    projectId: "bound-catalog-project",
    deploymentEpoch: "epoch-one",
    requestKey: "bound-catalog-request",
    origin: { principalId: "fixture-user", requestId: "request-origin" },
    runId: "run-bound-catalog",
    fence: 1,
    workflow,
    revision: "a".repeat(40),
    sourceTreeObjectId: "b".repeat(40),
    packet: {
      packetFingerprintSha256: "e".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: sha256(MANIFEST_CONTENT),
        sourcePathSha256: digest("fixture-input"),
        gitObjectId: "c".repeat(40),
        content: MANIFEST_CONTENT,
      },
      canon: null,
      reviewEvent: null,
      ...(parts.reviewScope === undefined ? {} : { reviewScope: parts.reviewScope }),
    },
    stepIds,
    toolPolicySha256: digest({
      workflow,
      stepIds,
      declaredTools: composition.declaredTools,
    }),
    workspacePath: "/tmp/docsfab-bound-catalog/workspace",
    stateDirectory: "/tmp/docsfab-bound-catalog/state",
    capsule: { ...capsuleBody, sha256: digest(capsuleBody) },
    composition,
    allowWrite: false,
  };
}

/** A focused review scope whose digest matches the pages it names. */
function reviewScope(options: {
  targetPaths: readonly string[];
  deferredPaths?: readonly string[];
  anchorPaths?: readonly string[];
  accounting?: Record<string, unknown>;
}): Record<string, unknown> {
  const targets = options.targetPaths.map((path) => ({ path, reason: "operator-named" as const }));
  const deferred = (options.deferredPaths ?? []).map((path) => ({
    path,
    reason: "over-budget" as const,
  }));
  const body = {
    schemaVersion: 1,
    kind: "docsfab-review-scope",
    scope: "focused-set",
    reason: "operator-named",
    targets,
    deferred,
  };
  return {
    ...body,
    scopeSha256: digest(body),
    corpusFileCount: 4096,
    // Anchors sit outside the scope digest, which covers the listed pages
    // only, so a sized anchor list does not have to re-seal the scope.
    ...(options.anchorPaths ? { anchorPaths: options.anchorPaths } : {}),
    ...(options.accounting ? { accounting: options.accounting } : {}),
  };
}

function reviewPages(count: number): string[] {
  return Array.from(
    { length: count },
    (_value, index) => `docs/page-${String(index).padStart(5, "0")}.md`,
  );
}

describe("catalogued hosted-runtime capacities", () => {
  it("fails closed on an uncatalogued name and returns the catalogued maximum for a declared one", () => {
    expect(() => catalogCapacity("hostInvoker.thisNameIsNotInTheCatalog")).toThrow(
      "Unknown operational limit hostInvoker.thisNameIsNotInTheCatalog is not declared in config/limits.yaml.",
    );
    expect(catalogCapacity("hostInvoker.requestMaxBytes")).toBe(
      limitDefinition("hostInvoker.requestMaxBytes").max,
    );
  });

  it("admits a step list at hostInvoker.requestStepIdsMax and refuses one past it", () => {
    const max = capacity("hostInvoker.requestStepIdsMax");
    const ids = (count: number) =>
      Array.from({ length: count }, (_value, index) => `step-${String(index).padStart(4, "0")}`);

    expect(parseHostRuntimeRequest(hostedRequest({ stepIds: ids(max) })).stepIds).toHaveLength(max);
    expect(() => parseHostRuntimeRequest(hostedRequest({ stepIds: ids(max + 1) }))).toThrow(
      "Hosted runtime rejected: invalid-step-catalog.",
    );
  });

  it("admits capsule evidence at hostInvoker.capsuleEvidenceMaxItems and refuses one past it", () => {
    const max = capacity("hostInvoker.capsuleEvidenceMaxItems");
    const entries = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({
        evidenceId: `evidence-${String(index).padStart(4, "0")}`,
        content: "bounded capsule evidence",
      }));

    expect(
      parseHostRuntimeRequest(hostedRequest({ selectedEvidence: entries(max) })).capsule
        .selectedEvidence,
    ).toHaveLength(max);
    expect(() =>
      parseHostRuntimeRequest(hostedRequest({ selectedEvidence: entries(max + 1) })),
    ).toThrow("Hosted runtime rejected: invalid-capsule.");
  });

  it("admits one evidence entry at hostInvoker.capsuleEvidenceItemMaxBytes and refuses one byte past it", () => {
    const max = capacity("hostInvoker.capsuleEvidenceItemMaxBytes");
    const entry = (bytes: number) => [{ evidenceId: "sized-evidence", content: "a".repeat(bytes) }];

    expect(
      parseHostRuntimeRequest(hostedRequest({ selectedEvidence: entry(max) })).capsule
        .selectedEvidence[0]!.content,
    ).toHaveLength(max);
    expect(() =>
      parseHostRuntimeRequest(hostedRequest({ selectedEvidence: entry(max + 1) })),
    ).toThrow("Hosted runtime rejected: invalid-capsule.");
  });

  it("admits projected evidence at hostInvoker.capsuleEvidenceJsonMaxBytes and refuses one byte past it", () => {
    const max = capacity("hostInvoker.capsuleEvidenceJsonMaxBytes");
    const itemMax = capacity("hostInvoker.capsuleEvidenceItemMaxBytes");
    // Fill with whole entries under the per-entry capacity, then size the last
    // entry so the serialized collection lands on the aggregate capacity
    // exactly.
    const collection = (total: number) => {
      const entries: { evidenceId: string; content: string }[] = [];
      for (let index = 0; ; index += 1) {
        entries.push({
          evidenceId: `evidence-${String(index).padStart(4, "0")}`,
          content: "",
        });
        const overhead = Buffer.byteLength(JSON.stringify(entries));
        const remaining = total - overhead;
        if (remaining <= itemMax) {
          entries[index]!.content = "a".repeat(remaining);
          break;
        }
        entries[index]!.content = "a".repeat(itemMax);
      }
      expect(Buffer.byteLength(JSON.stringify(entries))).toBe(total);
      return entries;
    };

    expect(
      Buffer.byteLength(
        JSON.stringify(
          parseHostRuntimeRequest(
            hostedRequest({ selectedEvidence: collection(max) }),
          ).capsule.selectedEvidence.map((entry) => ({
            evidenceId: entry.evidenceId,
            content: entry.content,
          })),
        ),
      ),
    ).toBe(max);
    expect(() =>
      parseHostRuntimeRequest(hostedRequest({ selectedEvidence: collection(max + 1) })),
    ).toThrow("Hosted runtime rejected: invalid-capsule.");
  });

  it("admits a review scope at reviewScope.maxTargets and refuses one page past it", () => {
    const max = capacity("reviewScope.maxTargets");

    expect(
      parseHostRuntimeRequest(
        hostedRequest({ reviewScope: reviewScope({ targetPaths: reviewPages(max) }) }),
      ).packet.reviewScope?.targets,
    ).toHaveLength(max);
    expect(() =>
      parseHostRuntimeRequest(
        hostedRequest({ reviewScope: reviewScope({ targetPaths: reviewPages(max + 1) }) }),
      ),
    ).toThrow("Hosted runtime rejected: invalid-review-scope.");
  });

  it("admits a page path at reviewScope.pathMaxChars and refuses one character past it", () => {
    const max = capacity("reviewScope.pathMaxChars");
    const sized = (length: number) => `docs/${"p".repeat(length - "docs/.md".length)}.md`;
    expect(sized(max)).toHaveLength(max);

    expect(
      parseHostRuntimeRequest(
        hostedRequest({ reviewScope: reviewScope({ targetPaths: [sized(max)] }) }),
      ).packet.reviewScope?.targets?.[0]?.path,
    ).toHaveLength(max);
    expect(() =>
      parseHostRuntimeRequest(
        hostedRequest({ reviewScope: reviewScope({ targetPaths: [sized(max + 1)] }) }),
      ),
    ).toThrow("Hosted runtime rejected: invalid-review-scope.");
  });

  it("admits continuation accounting at reviewScope.continuationTextMaxChars and refuses one character past it", () => {
    const max = capacity("reviewScope.continuationTextMaxChars");
    // The execution contract and this parser read one catalog entry.
    expect(REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT).toBe(max);
    const accounting = (limit: number) => ({
      radiusSha256: "f".repeat(64),
      radiusPageCount: 2,
      listedPageCount: 2,
      unlistedPageCount: 0,
      unreviewableNeighbourCount: 0,
      changedPathCount: null,
      continuationCharacterLimit: limit,
    });
    const scopeWith = (limit: number) =>
      reviewScope({
        targetPaths: ["docs/page-00000.md"],
        deferredPaths: ["docs/page-00001.md"],
        accounting: accounting(limit),
      });

    expect(
      parseHostRuntimeRequest(hostedRequest({ reviewScope: scopeWith(max) })).packet.reviewScope
        ?.accounting?.continuationCharacterLimit,
    ).toBe(max);
    expect(() =>
      parseHostRuntimeRequest(hostedRequest({ reviewScope: scopeWith(max + 1) })),
    ).toThrow("Hosted runtime rejected: invalid-review-scope.");
  });

  /**
   * Every anchor must name a page the scope already lists, so the fixture
   * splits one page more than the capacity across targets and deferrals; each
   * list is separately bounded by the same capacity, and neither half nears it.
   */
  it("admits review anchors at reviewScope.maxTargets and refuses one anchor past it", () => {
    const max = capacity("reviewScope.maxTargets");
    const pages = reviewPages(max + 1);
    const half = Math.ceil(pages.length / 2);
    const scopeWith = (anchorPaths: readonly string[]) =>
      reviewScope({
        targetPaths: pages.slice(0, half),
        deferredPaths: pages.slice(half),
        anchorPaths,
      });

    expect(
      parseHostRuntimeRequest(hostedRequest({ reviewScope: scopeWith(pages.slice(0, max)) })).packet
        .reviewScope?.anchorPaths,
    ).toHaveLength(max);
    expect(() => parseHostRuntimeRequest(hostedRequest({ reviewScope: scopeWith(pages) }))).toThrow(
      "Hosted runtime rejected: invalid-review-scope.",
    );
  });
});

describe("catalogued editorial-outcome capacities", () => {
  const reference = (index: number) => ({
    kind: "ontology",
    schemaVersion: 1,
    digest: sha256(`reference-${index}`),
    repositoryRevision: "a".repeat(40),
    repositoryContentDigest: sha256(`content-${index}`),
  });
  /** The candidate outcome shape a real projector emits. */
  const outcome = (parts: { evidenceRefs?: unknown[]; limitations?: string[] }) => ({
    state: "candidate",
    outcome: "update-recommended",
    decision: "update",
    candidateReference: {
      kind: "editorial-decision",
      schemaVersion: 3,
      digest: sha256("candidate"),
      repositoryRevision: "a".repeat(40),
      repositoryContentDigest: sha256("candidate-content"),
    },
    validatedReference: null,
    evidenceRefs: parts.evidenceRefs ?? [],
    limitations: parts.limitations ?? [],
  });

  it("admits evidence references at hostInvoker.editorialEvidenceRefsMax and refuses one past it", () => {
    const max = capacity("hostInvoker.editorialEvidenceRefsMax");
    const refs = (count: number) => Array.from({ length: count }, (_value, i) => reference(i));

    expect(
      decodeRunEditorialOutcomeV1(outcome({ evidenceRefs: refs(max) })).evidenceRefs,
    ).toHaveLength(max);
    expect(() => decodeRunEditorialOutcomeV1(outcome({ evidenceRefs: refs(max + 1) }))).toThrow(
      "Hosted runtime rejected: invalid-editorial-outcome.",
    );
  });

  it("admits limitations at hostInvoker.editorialLimitationsMax and refuses one past it", () => {
    const max = capacity("hostInvoker.editorialLimitationsMax");
    const codes = (count: number) =>
      Array.from({ length: count }, (_value, index) => `limitation-${index}`);

    expect(
      decodeRunEditorialOutcomeV1(outcome({ limitations: codes(max) })).limitations,
    ).toHaveLength(max);
    expect(() => decodeRunEditorialOutcomeV1(outcome({ limitations: codes(max + 1) }))).toThrow(
      "Hosted runtime rejected: invalid-editorial-outcome.",
    );
  });

  it("admits one limitation at hostInvoker.editorialLimitationMaxChars and refuses one character past it", () => {
    const max = capacity("hostInvoker.editorialLimitationMaxChars");

    expect(
      decodeRunEditorialOutcomeV1(outcome({ limitations: ["l".repeat(max)] })).limitations[0],
    ).toHaveLength(max);
    expect(() =>
      decodeRunEditorialOutcomeV1(outcome({ limitations: ["l".repeat(max + 1)] })),
    ).toThrow("Hosted runtime rejected: invalid-editorial-outcome.");
  });
});

describe("catalogued scoped-write grant capacities", () => {
  const CEILING = ["docs/"];
  const grant = (parts: {
    targets?: readonly unknown[];
    pathCeiling?: readonly string[];
    writeStepIds?: readonly string[];
    maximumChangedPaths?: number;
    maximumPatchBytes?: number;
  }): HostRuntimeWriteAuthorityV2 =>
    sealHostRuntimeWriteAuthority({
      schemaVersion: 2,
      kind: "docsfab-host-runtime-write-authority",
      deploymentId: "deployment-test",
      projectId: "project-test",
      deploymentEpoch: "epoch-test",
      requestKey: "request-test",
      runId: "run-bound-catalog",
      fence: 1,
      workflow: "update-documentation",
      sourceRevision: "a".repeat(40),
      sourceTreeObjectId: "b".repeat(40),
      pathCeiling: (parts.pathCeiling ?? CEILING) as HostRuntimeWriteAuthorityV2["pathCeiling"],
      targets: (parts.targets ?? [
        {
          path: "docs/guide.md",
          operations: ["modify"],
          preimageObjectId: "c".repeat(40),
          fileMode: "100644",
        },
      ]) as HostRuntimeWriteAuthorityV2["targets"],
      writeStepIds: (parts.writeStepIds ?? [
        "write-documentation",
      ]) as HostRuntimeWriteAuthorityV2["writeStepIds"],
      capsuleSha256: "d".repeat(64),
      compositionSha256: "e".repeat(64),
      toolPolicySha256: "f".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      limits: {
        maximumChangedPaths: parts.maximumChangedPaths ?? 16,
        maximumPatchBytes: parts.maximumPatchBytes ?? 1024,
      },
    });

  it("admits targets at writeAuthority.maxTargets and refuses one past it", () => {
    const max = capacity("writeAuthority.maxTargets");
    const targets = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({
        path: `docs/page-${String(index).padStart(5, "0")}.md`,
        operations: ["modify"],
        preimageObjectId: sha256(`preimage-${index}`).slice(0, 40),
        fileMode: "100644",
      }));

    expect(grant({ targets: targets(max) }).targets).toHaveLength(max);
    expect(() => grant({ targets: targets(max + 1) })).toThrow(
      "Hosted runtime rejected: write-authority-limits.",
    );
  });

  it("admits a path ceiling at writeAuthority.maxCeilingEntries and refuses one past it", () => {
    const max = capacity("writeAuthority.maxCeilingEntries");
    const ceiling = (count: number) =>
      Array.from({ length: count }, (_value, index) => `docs/area-${String(index)}/`);

    const admitted = grant({
      pathCeiling: ceiling(max),
      targets: [
        {
          path: "docs/area-0/guide.md",
          operations: ["modify"],
          preimageObjectId: "c".repeat(40),
          fileMode: "100644",
        },
      ],
    });
    expect(admitted.pathCeiling).toHaveLength(max);
    expect(() =>
      grant({
        pathCeiling: ceiling(max + 1),
        targets: [
          {
            path: "docs/area-0/guide.md",
            operations: ["modify"],
            preimageObjectId: "c".repeat(40),
            fileMode: "100644",
          },
        ],
      }),
    ).toThrow("Hosted runtime rejected: write-authority-ceiling.");
  });

  it("admits write steps at writeAuthority.maxWriteStepIds and refuses one past it", () => {
    const max = capacity("writeAuthority.maxWriteStepIds");
    const steps = (count: number) =>
      Array.from({ length: count }, (_value, index) => `write-step-${String(index)}`);

    expect(grant({ writeStepIds: steps(max) }).writeStepIds).toHaveLength(max);
    expect(() => grant({ writeStepIds: steps(max + 1) })).toThrow(
      "Hosted runtime rejected: write-authority-step-catalog.",
    );
  });

  it("admits a declared changed-path allowance at writeAuthority.maxTargets and refuses one past it", () => {
    const max = capacity("writeAuthority.maxTargets");

    expect(grant({ maximumChangedPaths: max }).limits.maximumChangedPaths).toBe(max);
    expect(() => grant({ maximumChangedPaths: max + 1 })).toThrow(
      "Hosted runtime rejected: write-authority-limits.",
    );
  });

  /**
   * Patch evidence carries the grant's target capacity. The refusal appends one
   * change to the sealed record, which the length guard must reject before the
   * digest check it would also fail; the named code tells the two apart.
   */
  it("admits patch evidence changes at writeAuthority.maxTargets and refuses one past it", () => {
    const max = capacity("writeAuthority.maxTargets");
    const authority = grant({ maximumChangedPaths: max });
    const changes: HostRuntimePatchChangeV1[] = Array.from({ length: max }, (_value, index) => ({
      path: `docs/added-${String(index).padStart(5, "0")}.md`,
      operation: "add",
      preimageObjectId: null,
      postimageObjectId: sha256(`postimage-${index}`).slice(0, 40),
      fileMode: "100644",
    }));
    const sealed = sealHostRuntimePatchEvidence({
      authority,
      candidateTreeObjectId: sha256("candidate-tree").slice(0, 40),
      changes,
      patch: "diff --git a/docs/added-00000.md b/docs/added-00000.md\n",
    });

    expect(parseHostRuntimePatchEvidence(sealed).changes).toHaveLength(max);
    expect(() =>
      parseHostRuntimePatchEvidence({
        ...sealed,
        changes: [...sealed.changes, sealed.changes[0]],
      }),
    ).toThrow("Hosted runtime rejected: invalid-patch-evidence.");
  });

  it("admits a declared patch allowance at writeAuthority.maxPatchBytes and refuses one byte past it", () => {
    const max = capacity("writeAuthority.maxPatchBytes");

    expect(grant({ maximumPatchBytes: max }).limits.maximumPatchBytes).toBe(max);
    expect(() => grant({ maximumPatchBytes: max + 1 })).toThrow(
      "Hosted runtime rejected: write-authority-limits.",
    );
  });

  /**
   * The sealed terminal shares the grant's patch allowance, and the host reads
   * worker terminal lines through this decoder. At the capacity the decode
   * passes this check and refuses later at the run-record shape.
   */
  it("admits a terminal patch at writeAuthority.maxPatchBytes and refuses one byte past it", () => {
    const max = capacity("writeAuthority.maxPatchBytes");
    const terminal = (bytes: number) => ({
      schemaVersion: 1,
      kind: "docsfab-host-runtime-terminal",
      status: "failed",
      runRecord: { schemaVersion: 1 },
      patch: "d".repeat(bytes),
    });

    expect(() => parseHostRuntimeTerminal(terminal(max))).toThrow(
      "Hosted runtime rejected: invalid-shape.",
    );
    expect(() => parseHostRuntimeTerminal(terminal(max + 1))).toThrow(
      "Hosted runtime rejected: invalid-terminal.",
    );
  });
});

/**
 * Descriptor-carried capacities live in `hostInvokerMain`'s argument and
 * descriptor handling, so each case spawns the real module with the sized
 * payload on an inherited descriptor and reads back the worker's message.
 */
describe("catalogued worker descriptor capacities", () => {
  const MAIN_URL = new URL("../src/host-invoker/main.ts", import.meta.url).href;
  const BYTE_BOUND_REFUSAL =
    "Hosted runtime file-descriptor input exceeded its configured byte bound.";

  async function runWorker(options: {
    args: readonly string[];
    payload?: { bytes: number; fill: string; json?: boolean };
    requestFdSlot?: number;
  }): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "docsfab-bound-descriptor-"));
    try {
      const requestPath = join(root, "request.json");
      await writeFile(requestPath, JSON.stringify(hostedRequest()));
      const requestFd = await open(requestPath, "r");
      let payloadFd: Awaited<ReturnType<typeof open>> | null = null;
      if (options.payload) {
        const payloadPath = join(root, "payload.bin");
        // Sized to the byte and valid JSON, so the parse after the descriptor
        // bound succeeds.
        const body = options.payload.json
          ? `["${options.payload.fill.repeat(options.payload.bytes - 4)}"]`
          : options.payload.fill.repeat(options.payload.bytes);
        expect(Buffer.byteLength(body)).toBe(options.payload.bytes);
        await writeFile(payloadPath, body);
        payloadFd = await open(payloadPath, "r");
      }
      const slot = options.requestFdSlot ?? 3;
      const stdio: (string | number)[] = ["ignore", "pipe", "pipe"];
      // Fill every descriptor below the request slot so the worker's own
      // admission range, not the spawn, decides which number is acceptable.
      while (stdio.length < slot) stdio.push("ignore");
      stdio.push(requestFd.fd);
      if (payloadFd) stdio.push(payloadFd.fd);
      const code = `
        const { hostInvokerMain } = await import(${JSON.stringify(MAIN_URL)});
        try {
          await hostInvokerMain(${JSON.stringify(options.args)});
          process.stdout.write("\\nOUTCOME:completed\\n");
        } catch (error) {
          process.stdout.write("\\nOUTCOME:" + (error && error.message ? error.message : String(error)) + "\\n");
        }
      `;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        {
          cwd: new URL("..", import.meta.url).pathname,
          stdio: stdio as never,
          env: {
            PATH: process.env.PATH,
            PI_OFFLINE: "1",
            DOCSFAB_CONFIG_ROOT: join(root, "empty-config"),
          },
        },
      );
      requestFd.close().catch(() => {});
      payloadFd?.close().catch(() => {});
      let out = "";
      child.stdout!.on("data", (bytes: Buffer) => {
        out += bytes.toString("utf8");
      });
      child.stderr!.resume();
      await new Promise<void>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", () => resolveExit());
      });
      const marker = out.lastIndexOf("\nOUTCOME:");
      expect(marker).toBeGreaterThanOrEqual(0);
      return out.slice(marker + "\nOUTCOME:".length).trim();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /**
   * The worker declares no independent replay-record allowance. Its bound is
   * the hosted output-line carrier, because the record is a strict subtree of a
   * terminal the host already admitted; the host refuses an oversized record
   * before it spawns a worker (`packages/host/test/service-dispatcher.test.ts`).
   */
  it("derives the replay-record bound from the hosted output-line carrier", () => {
    expect(MAX_REPLAY_RECORD_BYTES).toBe(HOSTED_OUTPUT_LINE_MAXIMUM_BYTES);
    // A catalogued `hostInvoker.replayRecordMaxBytes` would present a bound
    // nothing enforces, so its absence is asserted.
    expect(() => catalogCapacity("hostInvoker.replayRecordMaxBytes")).toThrow(
      "Unknown operational limit hostInvoker.replayRecordMaxBytes is not declared in config/limits.yaml.",
    );
  });

  it(
    "reads a credential at hostInvoker.credentialMaxBytes and refuses one byte past it",
    async () => {
      const max = capacity("hostInvoker.credentialMaxBytes");
      // Synthetic filler with no credential shape: only the byte count is under
      // test, and the worker zeroes the buffer either way.
      const admitted = await runWorker({
        args: ["--request-fd", "3", "--credential-fd", "4"],
        payload: { bytes: max, fill: "k" },
      });
      expect(admitted).not.toBe(BYTE_BOUND_REFUSAL);
      expect(
        await runWorker({
          args: ["--request-fd", "3", "--credential-fd", "4"],
          payload: { bytes: max + 1, fill: "k" },
        }),
      ).toBe(BYTE_BOUND_REFUSAL);
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it(
    "accepts a request descriptor at hostInvoker.descriptorNumberMax and refuses one past it",
    async () => {
      const max = capacity("hostInvoker.descriptorNumberMax");
      const admitted = await runWorker({
        args: ["--request-fd", String(max)],
        requestFdSlot: max,
      });
      expect(admitted).not.toContain("invalid --request-fd descriptor number");
      expect(await runWorker({ args: ["--request-fd", String(max + 1)], requestFdSlot: max })).toBe(
        "Hosted runtime invocation received an invalid --request-fd descriptor number.",
      );
      // Descriptors 0 to 2 are the standard streams and stay refused. Standard
      // input is attached, so accepting it would read an empty stream and refuse
      // with a different message instead of naming the descriptor.
      for (const standardStream of ["0", "2"]) {
        expect(await runWorker({ args: ["--request-fd", standardStream] })).toBe(
          "Hosted runtime invocation received an invalid --request-fd descriptor number.",
        );
      }
    },
    nestedDeadlineMs(180_000, 300_000),
  );
});
