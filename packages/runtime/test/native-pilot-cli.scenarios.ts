// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect } from "vitest";

import { usage } from "../src/cli/usage.js";
import { canonicalDigest } from "../src/contract-kit/index.js";

import {
  PilotCampaignCliError,
  type PilotCampaignCliDependencies,
} from "../src/native-compositions/pilot-cli.js";

import {
  NATIVE_PILOT_EVALUATION_ROLES,
  type CrossHarnessPilotReportV1,
  type NativePilotAttemptReceiptV1,
  type NativePilotBlindRolePacket,
  type NativePilotRunner,
} from "../src/native-compositions/pilot-runner.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

export function campaignArguments(
  campaignRoot: string,
  forbiddenRoots: readonly [string, string] = [
    "/private/tmp/docsfab-source",
    "/private/tmp/docsfab-target",
  ],
): string[] {
  return [
    "--corpus",
    "routing-task-guide-v1",
    "--campaign-root",
    campaignRoot,
    "--nemotron-record",
    "/private/tmp/docsfab-nemotron-record.json",
    "--nemotron-patch",
    "/private/tmp/docsfab-nemotron.patch",
    "--nemotron-document",
    "/private/tmp/docsfab-nemotron-guide.md",
    "--forbidden-root",
    forbiddenRoots[0],
    "--forbidden-root",
    forbiddenRoots[1],
    "--acknowledge-development-only-uncontained",
    "--json",
  ];
}

export async function cliFixture(): Promise<{
  root: string;
  campaignRoot: string;
  forbiddenRoots: readonly [string, string];
  replayRoot: string;
  executables: { codex: string; claude: string; python: string };
}> {
  const root = await privateDirectory("docsfab-pilot-cli-");
  const campaignRoot = join(root, "campaign");
  const forbiddenRoots = [join(root, "source"), join(root, "target")] as const;
  const replayRoot = join(root, "replay");
  const bin = join(root, "bin");
  await Promise.all(
    [campaignRoot, ...forbiddenRoots, replayRoot, bin].map(async (path) => {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  const executables = {
    codex: join(bin, "codex"),
    claude: join(bin, "claude"),
    python: join(bin, "python3"),
  };
  await Promise.all(
    Object.values(executables).map(async (path) => {
      await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  return { root, campaignRoot, forbiddenRoots, replayRoot, executables };
}

export function fakeCampaignDependencies(
  fixture: Awaited<ReturnType<typeof cliFixture>>,
  options: { failClaude?: boolean; failClaudePreflight?: boolean; nemotronNoop?: boolean } = {},
  loadCorpus: NonNullable<PilotCampaignCliDependencies["loadCorpus"]> = async () => {
    throw new Error("Unexpected corpus load; provide explicit internal qualification input.");
  },
) {
  const observedPreflights: string[] = [];
  const observedNativeRuns: number[] = [];
  const observedRoles: string[] = [];
  const observedExecutions: string[] = [];
  const events: string[] = [];
  const successfulOutputBytes = options.nemotronNoop
    ? ["a", "b"]
    : options.failClaude
      ? ["a", "c"]
      : ["a", "b", "c"];
  const packets = successfulOutputBytes.flatMap((outputByte) =>
    NATIVE_PILOT_EVALUATION_ROLES.map((role) =>
      blindPacket(role, `candidate-${outputByte.repeat(24)}`),
    ),
  );
  let packetIndex = 0;
  let nativeRunIndex = 0;
  const nativeReceipts = [
    attemptReceipt("a", 0),
    attemptReceipt("b", 1, options.failClaude ? "failed" : "succeeded"),
  ];
  const nemotronReceipt = attemptReceipt(
    "c",
    2,
    options.nemotronNoop ? "failed" : "succeeded",
    options.nemotronNoop ? "no-document-change" : undefined,
  );
  const runner: NativePilotRunner = {
    fixtureSha256: "f".repeat(64),
    blindingSeedCommitmentSha256: "e".repeat(64),
    campaignNonceSha256: "4".repeat(64),
    preflightNativeComposition: async ({ compositionId }) => {
      events.push("preflight");
      observedPreflights.push(compositionId);
      if (
        options.failClaudePreflight &&
        compositionId === "anthropic-claude-opus-4.7-claude-code-native-pilot"
      ) {
        throw new Error("provider-offline-preflight-failed");
      }
      return { kind: "docsfab-native-pilot-preflight-authority" };
    },
    runNativeAttempt: async () => {
      events.push("run-native");
      observedNativeRuns.push(nativeRunIndex);
      return nativeReceipts[nativeRunIndex++]!;
    },
    importFreshNemotronAttempt: async () => {
      throw new Error("legacy convenience import must not be used by the CLI");
    },
    validateFreshNemotronEvidence: async () => {
      events.push("validate-nemotron");
      return { kind: "docsfab-native-pilot-nemotron-import-authority" };
    },
    commitFreshNemotronAttempt: async () => {
      events.push("commit-nemotron");
      return nemotronReceipt;
    },
    openBlindBatch: async () => ({ kind: "docsfab-native-pilot-blind-batch-authority" }),
    nextBlindRolePacket: () => {
      const packet = packets[packetIndex++];
      return packet
        ? { authority: { kind: "docsfab-native-pilot-blind-role-authority" }, packet }
        : null;
    },
    admitBlindRoleResult: ({ bytes }) => {
      const parsed = JSON.parse(bytes.toString("utf8")) as {
        role: string;
        evaluatorExecutionIdentitySha256: string;
      };
      observedRoles.push(parsed.role);
      observedExecutions.push(parsed.evaluatorExecutionIdentitySha256);
      return {};
    },
    assembleCrossHarnessPilotReport: async () => fakeReport([nemotronReceipt, ...nativeReceipts]),
  };
  let randomSequence = 0;
  const environment = {
    HOME: fixture.root,
    USER: "tester",
    DOCSFAB_CODEX_EXECUTABLE: fixture.executables.codex,
    DOCSFAB_CLAUDE_EXECUTABLE: fixture.executables.claude,
    DOCSFAB_PYTHON_EXECUTABLE: fixture.executables.python,
  };
  const dependencies: PilotCampaignCliDependencies = {
    environment,
    loadEnvironment: () => undefined,
    log: () => undefined,
    loadCorpus,
    createRunner: async (options) => {
      expect(options.executablePaths).toEqual({
        codex: fixture.executables.codex,
        "claude-code": fixture.executables.claude,
      });
      expect(options.pythonExecutablePath).toBe(fixture.executables.python);
      expect(options.forbiddenRoots).toEqual(fixture.forbiddenRoots);
      expect(options.campaignNonce).toHaveLength(32);
      expect(options.durableReplayRoot).toBe(fixture.replayRoot);
      return runner;
    },
    loadNemotronArtifacts: async (input) => {
      if (input.workflow !== undefined) {
        expect(input.workflow.steps.map((step) => step.id)).toEqual([
          "plan-documentation",
          "write-documentation",
          "lint-documentation",
          "verify-technical-accuracy",
          "review-documentation",
          "evaluate-document-quality",
        ]);
        expect(input.workflowIdentity).toEqual({
          id: "create-documentation",
          sourceSha256: input.workflowIdentity?.sourceSha256,
        });
        expect(input.workflowIdentity?.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
      return {
        runRecordBytes: Buffer.from("record"),
        compositionEvidenceBytes: Buffer.from("composition-evidence"),
        aggregateBytes: Buffer.from("aggregate"),
        patchBytes: Buffer.from("patch"),
        documentBytes: Buffer.from("document"),
        sourceRoot: fixture.forbiddenRoots[1],
        freshness: fakeFreshness(),
      };
    },
    resolveInstalledRoot: () => fixture.forbiddenRoots[0],
    prepareDurableReplayRoot: async () => fixture.replayRoot,
    randomBytes: (size) => Buffer.alloc(size, ++randomSequence),
  };
  return {
    dependencies,
    environment,
    observedPreflights,
    observedNativeRuns,
    observedRoles,
    observedExecutions,
    events,
  };
}

export function fakeFreshness() {
  return {
    evidenceSha256: "7".repeat(64),
    sourceRootSha256: "8".repeat(64),
    sourceRevision: "2".repeat(40),
    sourceGitTree: "1".repeat(40),
    contextPacketSha256s: Array(6).fill("c".repeat(64)) as string[],
    skillBundleSha256s: Array(6).fill("5".repeat(64)) as string[],
    toolPolicySha256s: Array(6).fill("6".repeat(64)) as string[],
  };
}

export function attemptReceipt(
  byte: string,
  index: number,
  status: "succeeded" | "failed" = "succeeded",
  failureCategory?: string,
): NativePilotAttemptReceiptV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-cross-harness-attempt/v1",
    status,
    failureCategory: status === "failed" ? (failureCategory ?? "process-failed") : null,
    receiptSha256: byte.repeat(64),
    compositionId: [
      "openai-gpt-5.6-sol-codex-native-pilot",
      "anthropic-claude-opus-4.7-claude-code-native-pilot",
      "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi",
    ][index],
  } as NativePilotAttemptReceiptV1;
}

export function fakeReport(receipts: NativePilotAttemptReceiptV1[]): CrossHarnessPilotReportV1 {
  const body = {
    schemaVersion: 1,
    kind: "docsfab-cross-harness-comparison/v1",
    evidenceClass: "development-only-uncontained",
    liveEvidenceEstablished: true,
    commonEvaluationEstablished: false,
    track: "cross-harness-composition-six-step",
    fixtureSha256: "f".repeat(64),
    blindingSeedCommitmentSha256: "e".repeat(64),
    attemptSha256s: receipts.map((receipt) => receipt.receiptSha256),
    evaluationSha256s: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    reviewOrderSha256: "d".repeat(64),
    qualityComparisonStatus: "proxy-evaluation-incomplete",
    comparisons: receipts.map((receipt) => ({
      compositionId: receipt.compositionId,
      status: receipt.status,
      failureCategory: receipt.failureCategory ?? null,
      taskGuideScore: null,
      outputBarMet: false,
      durationMs: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0, total: 0 },
      providerTurns: 0,
      providerRequests: 0,
    })),
    ranking: { winnerCompositionId: null, reason: "development-pilot-cannot-rank" },
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
    limitations: ["unattested-agent-proxy-evaluation-only", "no-human-audience-evidence"],
  } as const;
  return { ...body, reportSha256: canonicalDigest(body) };
}

export function blindPacket(
  role: (typeof NATIVE_PILOT_EVALUATION_ROLES)[number],
  outputId = `candidate-${"a".repeat(24)}`,
): NativePilotBlindRolePacket {
  const documentSha256 = "d".repeat(64);
  return {
    role,
    outputId,
    fixtureSha256: "f".repeat(64),
    documentSha256,
    evaluationContextSha256: "e".repeat(64),
    evidenceClass: "unattested-agent-proxy",
    compositionVisible: false,
    document: Buffer.from("# Routing guide\n"),
    journeyEvidence: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-routing-clean-journey-result",
        pageSha256: documentSha256,
        taskSuccess: true,
        recoverySuccess: true,
        steps: [{ passed: true }, { passed: true }],
        metrics: { deadEnds: 0 },
      }),
    ),
    deterministicEvaluation: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-routing-document-evaluation",
        pageSha256: documentSha256,
        checks: routingChecks(),
        qualityScore: {
          total: 95,
          decision: "fail",
          hard_gates: {
            critical_factual_errors: 0,
            unsupported_critical_claims: 0,
            broken_required_examples: 0,
            missing_mandatory_content: 0,
            security_compliance_violations: 0,
            invalid_required_artifacts: 0,
          },
        },
        layeredEvaluation: {
          overall_decision: "insufficient-evidence",
          layers: {
            trustworthy_information: { decision: "pass" },
            transferable_understanding: { decision: "pass" },
            effective_experience: { decision: "pass" },
          },
          constraints: {
            accessibility: { assessment: "not-assessed" },
            security: { assessment: "met" },
          },
          outcomes: { human: [], agent: [{ outcome: "success", verified: true }] },
        },
      }),
    ),
  };
}

export function routingChecks(): Array<{ id: string; status: string; hardGate: boolean }> {
  return [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `ROUTE-L1-${String(index + 1).padStart(3, "0")}`,
      status: "passed",
      hardGate: true,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `ROUTE-L2-${String(index + 1).padStart(3, "0")}`,
      status: index === 2 ? "unavailable" : "passed",
      hardGate: false,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `ROUTE-L3-${String(index + 1).padStart(3, "0")}`,
      status: "passed",
      hardGate: false,
    })),
  ];
}

export async function privateDirectory(prefix: string): Promise<string> {
  const root = await roots.create(prefix, { mode: 0o700, realpath: true });
  return resolve(root);
}

export function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PilotCampaignCliError);
    expect((error as PilotCampaignCliError).code).toBe(code);
  }
}
