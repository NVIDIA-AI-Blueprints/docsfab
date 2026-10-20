// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A first pass whose only unresolved obligations are sources that disagree
 * stops with code `contradicted`, one recorded question built from the sides
 * the host verified, and a saved `needs-input` run record. At the shipped
 * entry (`executeRunRequest`, with an injected interpreter port and a stubbed
 * model bridge that returns real assessment text) and at
 * `validateFirstPassSupport` over a real support record.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const capture = vi.hoisted(() => ({
  invocations: [] as unknown[],
  completeFrom: undefined as unknown,
}));
const bridgeHolder = vi.hoisted(() => ({ bridge: undefined as unknown }));
const STOP_AT_EXECUTION = "test sentinel: the run reached workflow execution";

vi.mock("../src/cli/first-pass-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass-support.js")>();
  return {
    ...actual,
    createFirstPassSupportModelBridge: (
      ...args: Parameters<typeof actual.createFirstPassSupportModelBridge>
    ) =>
      (bridgeHolder.bridge as ReturnType<typeof actual.createFirstPassSupportModelBridge>) ??
      actual.createFirstPassSupportModelBridge(...args),
  };
});

vi.mock("../src/cli/run/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/run/execution.js")>();
  return {
    ...actual,
    executeWorkflowRun: async (...args: Parameters<typeof actual.executeWorkflowRun>) => {
      capture.invocations.push(args[0]);
      if (capture.completeFrom) {
        const source = capture.completeFrom as RunRecord;
        const invocation = args[0];
        const record = {
          ...source,
          id: invocation.request.runId!,
          status: "succeeded" as const,
          error: undefined,
          firstPassContradiction: undefined,
          firstPassContradictionAdmission: undefined,
          firstPassReplay: undefined,
          firstPassChoices: invocation.request.firstPassChoices,
          instructionContext: invocation.request.instructionContext,
          evidenceWarnings: [...(invocation.firstPassNotices ?? [])],
        };
        const { FileRunStore } = await import("../src/records/file-store.js");
        await new FileRunStore(invocation.config.stateDirectory).save(record);
        return { record, exitCode: 0 as const };
      }
      throw new Error(STOP_AT_EXECUTION);
    },
  };
});

import { handleRunsCommand, decodeSavedRunRecord } from "../src/cli/commands/runs.js";
import { admittedFirstPassRequestIntent, bindFirstPassKnowledge } from "../src/cli/first-pass.js";
import {
  firstPassAssessmentBindingSha256,
  FirstPassSupportValidationError,
  validateFirstPassSupport,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../src/cli/first-pass-support.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import {
  assembleLiveAgentHost,
  continueLiveFirstPassChoice,
  liveAgentWorkflowRunRequest,
  runBoundedWorkflow,
  runTerminalConversation,
} from "../src/live-agent/host.js";
import { DOCUMENTATION_WORK_REFUSAL } from "../src/live-agent/documentation-work-state.js";
import { planLiveFirstPassChoice } from "../src/live-agent/first-pass-choice.js";
import { createFirstPassReplay } from "../src/records/first-pass-replay.js";
import { repositoryVirtualCwd } from "../src/harness/pi-session.js";
import { restoreLocalContinuation } from "../src/live-agent/local-continuation.js";
import { loadLiveAgentCapabilities } from "../src/live-agent/capabilities.js";
import {
  LIVE_DELIVERY_FAILURES,
  LiveWorkflowDelivery,
} from "../src/live-agent/workflow-delivery.js";
import { firstPassContradictionAdmission } from "../src/records/first-pass-contradiction-admission.js";
import { FirstPassChoiceClaimStore } from "../src/records/first-pass-choice-store.js";
import { createFirstPassChoice } from "../src/records/first-pass-choice.js";
import {
  decodeRunRecordFirstPassContradiction,
  firstPassContradictionRecord,
  formatFirstPassContradictionLines,
  RunRecordFirstPassContradictionError,
} from "../src/cli/run/first-pass-contradiction-stop.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { limit } from "../src/config/limits.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { collectRunResultNextSteps } from "../src/operator/run-next-action.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { JsonEvidenceValue } from "../src/json-evidence.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { recordedIntent, quoteOf } from "./helpers/first-pass-intent.js";
import { isRecordableEvidenceWarning } from "../src/records/evidence-warnings.js";
import * as sourceQuotationRoles from "../src/repository/source-quotation-role.js";
import { escapeUndisplayable } from "../src/shared/display-text.js";
import { sealRequestIntent } from "../src/request-intent/seal.js";
import { initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { validModelConfig } from "./helpers.js";
import { parseEvidenceFrames, renderEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

import type { QaPartitionInputs } from "./helpers/qa-partition-inputs.js";

export function registerContradictionStopScenarios(inputs: QaPartitionInputs): void {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const roots = temporaryRoots();
  const REVISION = "f".repeat(40);
  const TARGET = "docs/deployment.md";
  const OPERATIONS = "docs/operations.md";
  const NEW_PAGE = "docs/service-port.md";
  const JOURNEY_MS = testTimeoutMs(30_000);
  // Only a multi-page update or a create reaches the first-pass stop.
  const CONFLICTING_SERVICE_PORT = inputs.conflictingServicePort;
  const CREATE_SERVICE_PORT =
    "Create a service port page for operators with the service's listening port. Ask a focused question if the sources disagree.";
  const HELPER_INSTRUCTION = `Update ${TARGET} with the service's listening port.`;
  const PORT_FILES = inputs.portFiles;

  beforeEach(() => {
    capture.invocations.length = 0;
    capture.completeFrom = undefined;
    bridgeHolder.bridge = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const root = value as Record<string, unknown>;
      return `{${Object.keys(root)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(root[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  interface Frame {
    readonly id: string;
    readonly path: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly text: string;
  }

  interface Seed {
    readonly id: string;
    readonly requiredSourceSupport: boolean;
    readonly targetPaths: readonly string[];
  }

  type Row = Record<string, unknown>;

  /**
   * A model bridge that answers every phase with real response text, so the
   * shipped bridge binding is computed from it. `assess` writes the assessment
   * rows; `extra` adds decomposed obligations.
   */
  function contradictionBridge(
    assess: (seeds: readonly Seed[], frames: readonly Frame[]) => Row[],
    extra: readonly Row[] = [],
  ): FirstPassSupportModelBridge & {
    readonly prompts: string[];
    readonly responses: string[];
  } {
    let lastIdentitySha256: string | undefined;
    let lastAssessmentBindingSha256: string | undefined;
    const prompts: string[] = [];
    const responses: string[] = [];
    return {
      prompts,
      responses,
      call: async (call: FirstPassSupportModelRequest) => {
        let value: unknown;
        if (call.prompt.startsWith("Phase: obligation-decomposition")) {
          value = { schemaVersion: 1, additionalObligations: extra };
        } else if (call.prompt.startsWith("Phase: obligation-completeness-audit")) {
          value = { schemaVersion: 1, complete: true, omissions: [] };
        } else {
          const line = call.prompt
            .split("\n")
            .find((entry) => entry.startsWith("Mandatory obligations: "))!;
          const seeds = JSON.parse(line.slice("Mandatory obligations: ".length)) as Seed[];
          value = {
            schemaVersion: 1,
            assessments: assess(seeds, parseEvidenceFrames(call.prompt) as unknown as Frame[]),
          };
        }
        const responseText = JSON.stringify(value);
        const identity = {
          providerId: "scripted-provider",
          modelId: "scripted-model",
          profileSha256: sha("profile"),
          compositionSha256: null,
          requestPolicySha256: null,
          systemPromptSha256: sha(call.systemPrompt),
          promptSha256: call.promptSha256,
          procedureSha256: call.procedureSha256,
          responseSha256: sha(responseText),
          turnEvidenceSha256: sha("turn-evidence"),
        };
        lastIdentitySha256 = sha(canonical(identity));
        if (!call.prompt.startsWith("Phase:")) {
          prompts.push(call.prompt);
          responses.push(responseText);
          lastAssessmentBindingSha256 = firstPassAssessmentBindingSha256(
            call.prompt,
            responseText,
            parseEvidenceFrames,
          );
        }
        return {
          responseText,
          identity,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
      lastAssessmentIdentitySha256: () => lastIdentitySha256,
      lastAssessmentBindingSha256: () => lastAssessmentBindingSha256,
    };
  }

  function frameWith(frames: readonly Frame[], path: string, needle: string): Frame {
    const frame = frames.find((entry) => entry.path === path && entry.text.includes(needle));
    if (!frame) throw new Error(`fixture: no offered span of ${path} holds ${needle}`);
    return frame;
  }

  type SidesSpec = (frames: readonly Frame[]) => Row[] | undefined;

  /** Every required obligation contradicted between the given sides; the rest supported. */
  function contradictedRows(
    sides: SidesSpec,
    cite: (frames: readonly Frame[]) => string[] = (frames) => [
      frameWith(frames, "deploy.yaml", "9090").id,
      frameWith(frames, "src/server.ts", "8088").id,
    ],
    override: (seed: Seed) => Row | undefined = () => undefined,
  ) {
    return (seeds: readonly Seed[], frames: readonly Frame[]): Row[] =>
      seeds.map((seed) => {
        const replaced = override(seed);
        if (replaced) return { obligationId: seed.id, ...replaced };
        // The operations page agrees with every source; only the port disagrees.
        if (seed.requiredSourceSupport && seed.targetPaths.every((path) => path === OPERATIONS)) {
          return {
            obligationId: seed.id,
            status: "supported",
            evidenceSpanIds: [frameWith(frames, OPERATIONS, "restart").id],
            detail: "The operations page states the restart step.",
          };
        }
        if (!seed.requiredSourceSupport) {
          return {
            obligationId: seed.id,
            status: "supported",
            evidenceSpanIds: [],
            detail: "Bound by the instruction.",
          };
        }
        const written = sides(frames);
        return {
          obligationId: seed.id,
          status: "contradicted",
          evidenceSpanIds: cite(frames),
          detail: "deploy.yaml and src/server.ts name different listening ports.",
          ...(written === undefined ? {} : { sides: written }),
        };
      });
  }

  const PORT_SIDES: SidesSpec = (frames) => [
    { spanId: frameWith(frames, "deploy.yaml", "9090").id, value: "9090" },
    { spanId: frameWith(frames, "src/server.ts", "8088").id, value: "8088" },
  ];

  function supportingRows(seeds: readonly Seed[], frames: readonly Frame[]): Row[] {
    return seeds.map((seed) => ({
      obligationId: seed.id,
      status: "supported",
      evidenceSpanIds: seed.requiredSourceSupport
        ? [
            seed.targetPaths.every((path) => path === OPERATIONS)
              ? frameWith(frames, OPERATIONS, "restart").id
              : frameWith(frames, "src/server.ts", "8088").id,
          ]
        : [],
      detail: "Supported by the offered span.",
    }));
  }

  // ---------------------------------------------------------------------------
  // The shipped entry.

  function stubConfig(stateDirectory: string): DocsFabConfig {
    return {
      projectRoot: runtimeRoot,
      skillCrateDirectory: join(runtimeRoot, "skill-crate"),
      qualityDirectory: join(runtimeRoot, "quality"),
      qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      stateDirectory,
      retryPolicy: {
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: [],
      },
      model: validModelConfig,
    };
  }

  async function repository(
    extraFiles: Readonly<Record<string, string>> = {},
    withProjectConfig = true,
    baseFiles: Readonly<Record<string, string>> = PORT_FILES,
    projectConfiguration?: string,
  ): Promise<{
    repositoryPath: string;
    stateDirectory: string;
  }> {
    const root = await roots.create("docsfab-contradiction-stop-");
    const repositoryPath = join(root, "repo");
    await initFixtureRepo(repositoryPath, {
      ...baseFiles,
      ...extraFiles,
      ...(withProjectConfig
        ? {
            ".docsfab.json":
              projectConfiguration ??
              `${JSON.stringify({
                schemaVersion: 1,
                gitlab: { remote: "origin", defaultBranch: "main" },
                provider: { configuration: "host" },
                storage: { scope: "user-private" },
              })}\n`,
          }
        : {}),
    });
    // Each fixture owns the run-store parent and its private sibling claim journal.
    const stateDirectory = join(await roots.create("docsfab-contradiction-state-"), "runs");
    await mkdir(stateDirectory, { mode: 0o700 });
    return {
      repositoryPath,
      stateDirectory,
    };
  }

  function splitExportBridge(unresolvedCode = false, metadataQuote?: string) {
    const split = [
      {
        id: "decomposed-no-file-write",
        condition: "does not write a file",
        documentation: metadataQuote ?? inputs.exportDocumentation,
        implementation: inputs.exportImplementation,
      },
      {
        id: "decomposed-unimplemented-command-comment",
        condition: "note that the file comment describes a command that is not implemented.",
        documentation: unresolvedCode ? inputs.exportError : inputs.exportUsage,
        implementation: inputs.exportDeclaration,
      },
    ];
    return contradictionBridge(
      (seeds, frames) =>
        seeds.map((seed) => {
          const claim = split.find((entry) => entry.id === seed.id);
          const source = frameWith(frames, "src/export.ts", `${inputs.exportFunction}`);
          return claim
            ? {
                obligationId: seed.id,
                status: "contradicted",
                evidenceSpanIds: [source.id],
                sides: [claim.documentation, claim.implementation].map((value) => ({
                  spanId: source.id,
                  value,
                })),
                detail: "The header describes a different interface from the function body.",
              }
            : {
                obligationId: seed.id,
                status: "supported",
                evidenceSpanIds: seed.requiredSourceSupport ? [source.id] : [],
                detail: "The exact implementation provides the function evidence.",
              };
        }),
      split.map((claim) => ({
        id: claim.id,
        origin: "explicit",
        instructionQuote: claim.condition,
        targetPaths: ["docs/export.md"],
        condition: claim.condition,
        requiredSourceSupport: true,
      })),
    );
  }

  function runRequest(
    repositoryPath: string,
    json = false,
    workflow: "update-documentation" | "create-documentation" = "update-documentation",
    instruction = workflow === "update-documentation"
      ? CONFLICTING_SERVICE_PORT
      : CREATE_SERVICE_PORT,
  ): RunRequestWithPublishProjection {
    return {
      workflow,
      repositoryPath,
      revision: "HEAD",
      instruction,
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json,
      showScan: false,
      patchOnly: true,
    } as RunRequestWithPublishProjection;
  }

  /**
   * The interpretation admits an update of the deployment and operations
   * guides, or the create of the service port page.
   */
  function admitPages(
    workflow: string,
    sources: readonly { readonly path: string; readonly quote: string }[] = [],
  ): RequestIntentInterpreterPort {
    const proposal =
      workflow === "update-documentation"
        ? {
            operation: "update",
            targets: [
              {
                path: TARGET,
                role: "write",
                chosenFrom: "inventory",
                quote: "the deployment guide",
              },
              {
                path: OPERATIONS,
                role: "write",
                chosenFrom: "inventory",
                quote: "the operations guide",
              },
            ],
          }
        : {
            operation: "create",
            targets: [
              {
                path: NEW_PAGE,
                role: "write",
                chosenFrom: "proposed-new",
                quote: "a service port page",
              },
            ],
          };
    return {
      async call() {
        return {
          text: JSON.stringify({
            authorityPreference: { preference: "unspecified", quote: null },
            ...proposal,
            ...(sources.length > 0 ? { sources } : {}),
          }),
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
    };
  }

  async function run(
    request: RunRequestWithPublishProjection,
    stateDirectory: string,
    requestInterpreter: RequestIntentInterpreterPort = admitPages(request.workflow),
  ): Promise<{ result?: RunRecord; error?: unknown; logs: string[]; errors: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      return {
        result: (await executeRunRequest(request, stubConfig(stateDirectory), {
          requestInterpreter,
        })) as RunRecord,
        logs,
        errors,
      };
    } catch (caught) {
      return { error: caught, logs, errors };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  /** What `docsfab runs show` prints for a saved run, with or without `--json`. */
  async function runsShow(runId: string, stateDirectory: string, json: boolean): Promise<string[]> {
    const output: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      output.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        runId,
        ...(json ? ["--json"] : []),
        "--state-dir",
        stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    return output;
  }

  /** The saved record, read as `runs show` reads it, and its decoded question field. */
  async function savedContradiction(stateDirectory: string, runId: string) {
    const raw = JSON.parse(
      await readFile(join(stateDirectory, `${runId}.json`), "utf8"),
    ) as JsonEvidenceValue;
    const record = decodeSavedRunRecord(raw, runId);
    return {
      record,
      field: decodeRunRecordFirstPassContradiction(record.firstPassContradiction),
    };
  }

  async function savedRunIds(stateDirectory: string): Promise<string[]> {
    return (await readdir(stateDirectory))
      .filter((name) => name.endsWith(".json") && !name.includes("index"))
      .map((name) => name.slice(0, -".json".length));
  }

  async function removeReplayFromLegacyStop(stateDirectory: string, runId: string): Promise<void> {
    const path = join(stateDirectory, `${runId}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    delete record.firstPassReplay;
    await writeFile(path, `${JSON.stringify(record)}\n`);
    await unlink(
      join(dirname(stateDirectory), "first-pass-choice-claims", `assessment-${sha(runId)}.json`),
    );
  }

  describe("a contradiction-only first pass stops with one recorded question, at the shipped entry", {
    timeout: JOURNEY_MS,
  }, () => {
    it("continues a saved contradiction from the live implementation reply with attributed evidence", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      expect(stopped.result?.status).toBe("needs-input");
      const reply = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: "Use the implementation",
      });
      expect(reply.kind).toBe("choice");
      if (reply.kind !== "choice") return;

      capture.completeFrom = stopped.result;
      const continued = await continueLiveFirstPassChoice(reply.plan, {
        repositoryPath,
        allowWrite: true,
        config: stubConfig(stateDirectory),
        persist: async () => ({ status: "not-needed" }),
        runWorkflow: async (input) =>
          (await executeRunRequest(liveAgentWorkflowRunRequest(input), input.config, {
            requestInterpreter: admitPages(input.workflow),
          })) as RunRecord,
      });
      expect(continued.status).toBe("succeeded");
      expect(continued.firstPassChoices).toHaveLength(1);
      expect(continued.evidenceWarnings?.join("\n")).toContain("operator-choice:");
      expect(continued.evidenceWarnings?.join("\n")).toContain("src/server.ts");
      expect(JSON.stringify(continued)).not.toContain("Use the implementation");
      expect(capture.invocations).toHaveLength(1);
      const original = await savedContradiction(stateDirectory, stopped.result!.id);
      expect(original.record.status).toBe("needs-input");
      expect(original.record.firstPassContradiction).toEqual(
        stopped.result?.firstPassContradiction,
      );
      const repeated = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: "Use the implementation",
      });
      expect(repeated.kind).toBe("choice");
      if (repeated.kind !== "choice") return;
      const duplicate = await continueLiveFirstPassChoice(repeated.plan, {
        repositoryPath,
        allowWrite: true,
        config: stubConfig(stateDirectory),
        persist: async () => ({ status: "not-needed" }),
        runWorkflow: async () => {
          throw new Error("duplicate invoked workflow");
        },
      });
      expect(duplicate.id).toBe(continued.id);
      expect(capture.invocations).toHaveLength(1);
      const childPath = join(stateDirectory, `${continued.id}.json`);
      const alteredChild = JSON.parse(await readFile(childPath, "utf8"));
      delete alteredChild.firstPassChoices;
      await writeFile(childPath, `${JSON.stringify(alteredChild)}\n`);
      await expect(
        continueLiveFirstPassChoice(repeated.plan, {
          repositoryPath,
          allowWrite: true,
          config: stubConfig(stateDirectory),
          persist: async () => ({ status: "not-needed" }),
          runWorkflow: async () => {
            throw new Error("tampered child invoked workflow");
          },
        }),
      ).rejects.toThrow("The saved first-pass choice cannot continue this run (tampered).");
      expect(capture.invocations).toHaveLength(1);
    });

    it("continues a saved source choice after reassessment renames the same verified dispute", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      expect(stopped.result?.status).toBe("needs-input");
      expect(stopped.result?.firstPassReplay?.replaySha256).toMatch(/^[a-f0-9]{64}$/u);
      const offered = decodeRunRecordFirstPassContradiction(stopped.result!.firstPassContradiction);
      const oldId = offered.contradictions[0]!.obligationId;
      const reply = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: offered.question.options.find((option) => option.includes("src/server.ts"))!,
      });
      expect(reply.kind).toBe("choice");
      if (reply.kind !== "choice") return;

      const unrelated = await run(
        runRequest(repositoryPath, false, "create-documentation"),
        stateDirectory,
      );
      expect(unrelated.result?.status).toBe("needs-input");

      const renamedId = "decomposed-renamed-port";
      const renamedBridge = contradictionBridge(
        (seeds, frames) =>
          seeds.map((seed) =>
            seed.id === renamedId
              ? {
                  obligationId: seed.id,
                  status: "contradicted",
                  evidenceSpanIds: PORT_SIDES(frames)!.map((side) => side.spanId),
                  sides: PORT_SIDES(frames),
                  detail: "The same two source values disagree.",
                }
              : supportingRows([seed], frames)[0]!,
          ),
        [
          {
            id: renamedId,
            origin: "inferred",
            instructionQuote: null,
            targetPaths: [TARGET],
            condition: "The service port agrees across sources.",
            requiredSourceSupport: true,
          },
        ],
      );
      bridgeHolder.bridge = renamedBridge;
      capture.completeFrom = stopped.result;
      const continued = await continueLiveFirstPassChoice(reply.plan, {
        repositoryPath,
        allowWrite: true,
        config: stubConfig(stateDirectory),
        persist: async () => ({ status: "not-needed" }),
        runWorkflow: async (input) =>
          (await executeRunRequest(liveAgentWorkflowRunRequest(input), input.config, {
            requestInterpreter: admitPages(input.workflow),
          })) as RunRecord,
      });
      expect(continued.status).toBe("succeeded");
      expect(continued.firstPassChoices?.map((choice) => choice.obligationId)).toEqual([oldId]);
      expect(continued.evidenceWarnings?.join("\n")).toContain("operator-choice:");
      expect(renamedBridge.prompts).toHaveLength(0);
    });

    it("refuses a changed saved assessment before admitting its offered option", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      expect(stopped.result?.status).toBe("needs-input");
      const recordPath = join(stateDirectory, `${stopped.result!.id}.json`);
      const saved = JSON.parse(await readFile(recordPath, "utf8"));
      saved.firstPassReplay.support.obligations[0].condition = "A different claim";
      await writeFile(recordPath, `${JSON.stringify(saved)}\n`);
      const offered = decodeRunRecordFirstPassContradiction(stopped.result!.firstPassContradiction);
      expect(
        await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText: offered.question.options[0]!,
        }),
      ).toMatchObject({ kind: "refused" });
      expect(capture.invocations).toHaveLength(0);
    });

    it("refuses a self-rehashed assessment that drops an unresolved obligation", async () => {
      const bridge = contradictionBridge(contradictedRows(PORT_SIDES), [
        {
          id: "decomposed-second",
          origin: "inferred",
          instructionQuote: null,
          targetPaths: [TARGET],
          condition: "The second service port remains consistent.",
          requiredSourceSupport: true,
        },
      ]);
      bridgeHolder.bridge = bridge;
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      const path = join(stateDirectory, `${stopped.result!.id}.json`);
      const saved = JSON.parse(await readFile(path, "utf8"));
      const replay = saved.firstPassReplay;
      const support = replay.support as SupportFixture;
      support.obligations = support.obligations.filter((row) => row.id !== "decomposed-second");
      rehash(support);
      saved.firstPassReplay = createFirstPassReplay({
        snapshot: replay.snapshot,
        support,
        targetPaths: replay.targetPaths,
        assessmentIdentitySha256: replay.assessmentIdentitySha256,
        assessmentBindingSha256: bridgeBinding(bridge.prompts.at(-1)!, support),
      });
      await writeFile(path, `${JSON.stringify(saved)}\n`);
      const question = decodeRunRecordFirstPassContradiction(
        stopped.result!.firstPassContradiction,
      );
      const selected = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: question.question.options.find((option) => option.includes("src/server.ts"))!,
      });
      expect(selected.kind).toBe("choice");
      if (selected.kind !== "choice") return;
      await expect(
        continueLiveFirstPassChoice(selected.plan, {
          repositoryPath,
          allowWrite: true,
          config: stubConfig(stateDirectory),
          persist: async () => ({ status: "not-needed" }),
        }),
      ).rejects.toMatchObject({ code: "tampered" });
      expect(capture.invocations).toHaveLength(0);
    });

    it.each(["missing seal", "changed seal", "removed capsule"] as const)(
      "refuses %s before reserving a choice",
      async (change) => {
        bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
        const { repositoryPath, stateDirectory } = await repository();
        const stopped = await run(runRequest(repositoryPath), stateDirectory);
        const sealPath = join(
          dirname(stateDirectory),
          "first-pass-choice-claims",
          `assessment-${sha(stopped.result!.id)}.json`,
        );
        if (change === "missing seal") await unlink(sealPath);
        else if (change === "changed seal") {
          const seal = JSON.parse(await readFile(sealPath, "utf8"));
          seal.replaySha256 = "0".repeat(64);
          await writeFile(sealPath, `${JSON.stringify(seal)}\n`);
        } else {
          const recordPath = join(stateDirectory, `${stopped.result!.id}.json`);
          const record = JSON.parse(await readFile(recordPath, "utf8"));
          delete record.firstPassReplay;
          await writeFile(recordPath, `${JSON.stringify(record)}\n`);
        }
        const question = decodeRunRecordFirstPassContradiction(
          stopped.result!.firstPassContradiction,
        );
        const selected = await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText: question.question.options.find((option) => option.includes("src/server.ts"))!,
        });
        expect(selected.kind).toBe("choice");
        if (selected.kind !== "choice") return;
        await expect(
          continueLiveFirstPassChoice(selected.plan, {
            repositoryPath,
            allowWrite: true,
            config: stubConfig(stateDirectory),
            persist: async () => ({ status: "not-needed" }),
          }),
        ).rejects.toMatchObject({ code: "tampered" });
        expect(capture.invocations).toHaveLength(0);
      },
    );

    it("keeps current documentation roots in force before replaying a saved assessment", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      expect(stopped.result?.firstPassReplay).toBeDefined();
      await expect(
        bindFirstPassKnowledge({
          request: runRequest(repositoryPath),
          config: stubConfig(stateDirectory),
          workspacePath: repositoryPath,
          revision: stopped.result!.repository.revision,
          firstPassReplay: stopped.result!.firstPassReplay,
          firstPassChoices: [],
          documentationRoots: ["src/"],
          status: () => undefined,
        }),
      ).rejects.toMatchObject({ code: "documentation-roots-outside-write-roots" });
      expect(capture.invocations).toHaveLength(0);
    });

    it.each(["offered option", "implementation reply"] as const)(
      "continues the current producer's location-only source from its %s without inventing a scalar",
      async (replyKind) => {
        bridgeHolder.bridge = contradictionBridge(contradictedRows(() => undefined));
        const { repositoryPath, stateDirectory } = await repository();
        const stopped = await run(runRequest(repositoryPath), stateDirectory);
        const parentPath = join(stateDirectory, `${stopped.result!.id}.json`);
        const parentBytes = await readFile(parentPath, "utf8");
        const field = decodeRunRecordFirstPassContradiction(stopped.result!.firstPassContradiction);
        expect(
          field.contradictions.every((item) => item.sides.every((side) => side.value === null)),
        ).toBe(true);
        for (const suffix of ["null", "8088"]) {
          expect(
            await planLiveFirstPassChoice({
              stateDirectory,
              repositoryPath,
              pendingRunId: stopped.result!.id,
              replyText: `Use the implementation: ${suffix} from src/server.ts.`,
            }),
          ).toMatchObject({ kind: "refused" });
        }
        const replyText =
          replyKind === "offered option"
            ? field.question.options.find((option) => option.includes("src/server.ts"))!
            : "Use the implementation";
        const selected = await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText,
        });
        expect(selected.kind).toBe("choice");
        if (selected.kind !== "choice") return;
        capture.completeFrom = stopped.result;
        const continued = await continueLiveFirstPassChoice(selected.plan, {
          repositoryPath,
          allowWrite: true,
          config: stubConfig(stateDirectory),
          persist: async () => ({ status: "not-needed" }),
          runWorkflow: async (input) =>
            (await executeRunRequest(liveAgentWorkflowRunRequest(input), input.config, {
              requestInterpreter: admitPages(input.workflow),
            })) as RunRecord,
        });
        expect(continued.status).toBe("succeeded");
        expect(capture.invocations).toHaveLength(1);
        const attribution = continued.evidenceWarnings!.filter((line) =>
          line.startsWith("operator-choice:"),
        );
        expect(attribution.join("\n")).toContain("src/server.ts");
        expect(attribution.join("\n")).toContain("no verified scalar value");
        expect(attribution.join("\n")).not.toMatch(/with value null|8088/u);
        expect(await readFile(parentPath, "utf8")).toBe(parentBytes);
        const claimBytes = await readFile(
          join(
            dirname(stateDirectory),
            "first-pass-choice-claims",
            `${sha(stopped.result!.id)}.0.json`,
          ),
          "utf8",
        );
        expect(claimBytes).not.toContain(replyText);
        expect(claimBytes).not.toContain('"value"');
        expect(JSON.stringify(continued.firstPassChoices)).not.toContain(replyText);
      },
    );

    it("retains a location-only choice when the same excerpt gains a scalar in reassessment", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(() => undefined));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      const parentPath = join(stateDirectory, `${stopped.result!.id}.json`);
      const parentBytes = await readFile(parentPath, "utf8");
      const field = decodeRunRecordFirstPassContradiction(stopped.result!.firstPassContradiction);
      const selected = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: field.question.options.find((option) => option.includes("src/server.ts"))!,
      });
      expect(selected.kind).toBe("choice");
      if (selected.kind !== "choice") return;
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      capture.completeFrom = stopped.result;
      await expect(
        continueLiveFirstPassChoice(selected.plan, {
          repositoryPath,
          allowWrite: true,
          config: stubConfig(stateDirectory),
          persist: async () => ({ status: "not-needed" }),
          runWorkflow: async (input) =>
            (await executeRunRequest(liveAgentWorkflowRunRequest(input), input.config, {
              requestInterpreter: admitPages(input.workflow),
            })) as RunRecord,
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
      });
      expect(capture.invocations).toHaveLength(1);
      expect(capture.invocations[0]).toMatchObject({
        firstPassNotices: expect.arrayContaining([
          expect.stringContaining("with no verified scalar value"),
        ]),
      });
      expect(await readFile(parentPath, "utf8")).toBe(parentBytes);
      const claim = await new FirstPassChoiceClaimStore(stateDirectory).inspect(stopped.result!.id);
      const child = decodeSavedRunRecord(
        JSON.parse(await readFile(join(stateDirectory, `${claim!.successorRunId}.json`), "utf8")),
        claim!.successorRunId,
      );
      expect(child).toMatchObject({ status: "succeeded" });
      expect(child.firstPassChoices).toHaveLength(1);
    });

    it("refuses a selected side omitted by the fresh assessment before workflow execution", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository({
        "src/alternate.ts": "export const alternatePort = 7070;\n",
      });
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      await removeReplayFromLegacyStop(stateDirectory, stopped.result!.id);
      const parentPath = join(stateDirectory, `${stopped.result!.id}.json`);
      const parentBytes = await readFile(parentPath, "utf8");
      const selected = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: "Use the implementation",
      });
      expect(selected.kind).toBe("choice");
      if (selected.kind !== "choice") return;
      bridgeHolder.bridge = contradictionBridge(
        contradictedRows(
          (frames) => [
            { spanId: frameWith(frames, "deploy.yaml", "9090").id, value: "9090" },
            { spanId: frameWith(frames, "src/alternate.ts", "7070").id, value: "7070" },
          ],
          (frames) => [
            frameWith(frames, "deploy.yaml", "9090").id,
            frameWith(frames, "src/alternate.ts", "7070").id,
          ],
        ),
      );
      capture.completeFrom = stopped.result;
      await expect(
        continueLiveFirstPassChoice(selected.plan, {
          repositoryPath,
          allowWrite: true,
          config: stubConfig(stateDirectory),
          persist: async () => ({ status: "not-needed" }),
          runWorkflow: async (input) =>
            (await executeRunRequest(liveAgentWorkflowRunRequest(input), input.config, {
              requestInterpreter: admitPages(input.workflow),
            })) as RunRecord,
        }),
      ).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining(
          "The saved first-pass choice cannot continue this run (stale).",
        ),
        steps: [],
      });
      expect(capture.invocations).toHaveLength(0);
      expect(await readFile(parentPath, "utf8")).toBe(parentBytes);
    });

    it.each(["unchanged", "condition", "targetPaths"] as const)(
      "binds an inferred obligation's original metadata when %s is assessed again",
      async (drift) => {
        const obligation = {
          id: "decomposed-port-binding",
          origin: "inferred",
          instructionQuote: null,
          targetPaths: [TARGET],
          condition: "The service's listening port agrees across sources.",
          requiredSourceSupport: true,
        };
        const assess = (seeds: readonly Seed[], frames: readonly Frame[]) =>
          seeds.map((seed) =>
            seed.id === obligation.id
              ? {
                  obligationId: seed.id,
                  status: "contradicted",
                  evidenceSpanIds: PORT_SIDES(frames)!.map((side) => side.spanId),
                  sides: PORT_SIDES(frames),
                  detail: "Two verified sources name different listening ports.",
                }
              : supportingRows([seed], frames)[0]!,
          );
        bridgeHolder.bridge = contradictionBridge(assess, [obligation]);
        const { repositoryPath, stateDirectory } = await repository();
        const stopped = await run(runRequest(repositoryPath), stateDirectory);
        expect(stopped.result?.status).toBe("needs-input");
        await removeReplayFromLegacyStop(stateDirectory, stopped.result!.id);
        const parentPath = join(stateDirectory, `${stopped.result!.id}.json`);
        const parentBytes = await readFile(parentPath, "utf8");
        const field = decodeRunRecordFirstPassContradiction(stopped.result!.firstPassContradiction);
        const selected = await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText: field.question.options.find((option) => option.includes("src/server.ts"))!,
        });
        expect(selected.kind).toBe("choice");
        if (selected.kind !== "choice") return;
        bridgeHolder.bridge = contradictionBridge(assess, [
          {
            ...obligation,
            ...(drift === "condition"
              ? { condition: "The service's health response status agrees across sources." }
              : drift === "targetPaths"
                ? { targetPaths: [OPERATIONS] }
                : {}),
          },
        ]);
        capture.completeFrom = stopped.result;
        const runWorkflow = vi.fn(
          async (input: Parameters<typeof runBoundedWorkflow>[0]) =>
            (await executeRunRequest(liveAgentWorkflowRunRequest(input), input.config, {
              requestInterpreter: admitPages(input.workflow),
            })) as RunRecord,
        );
        const options = {
          repositoryPath,
          allowWrite: true,
          config: stubConfig(stateDirectory),
          persist: async () => ({ status: "not-needed" as const }),
          runWorkflow,
        };
        if (drift === "unchanged") {
          expect(await continueLiveFirstPassChoice(selected.plan, options)).toMatchObject({
            status: "succeeded",
          });
          expect(capture.invocations).toHaveLength(1);
        } else {
          await expect(continueLiveFirstPassChoice(selected.plan, options)).resolves.toMatchObject({
            status: "failed",
            error: expect.stringContaining(
              "The saved first-pass choice cannot continue this run (stale).",
            ),
            steps: [],
          });
          expect(capture.invocations).toHaveLength(0);
          const claim = await new FirstPassChoiceClaimStore(stateDirectory).inspect(
            stopped.result!.id,
          );
          const childPath = join(stateDirectory, `${claim!.successorRunId}.json`);
          const child = decodeSavedRunRecord(
            JSON.parse(await readFile(childPath, "utf8")),
            claim!.successorRunId,
          );
          expect(child.status).toBe("failed");
          expect(child.steps).toEqual([]);
          expect(child.firstPassChoices).toHaveLength(1);
          const repeated = await continueLiveFirstPassChoice(selected.plan, options);
          expect(repeated.id).toBe(child.id);
          expect(repeated.status).toBe("failed");
          expect(runWorkflow).toHaveBeenCalledTimes(1);
        }
        expect(await readFile(parentPath, "utf8")).toBe(parentBytes);
      },
    );

    it.each(["missing", "foreign", "wrong", "foreign-owner", "unknown-owner"] as const)(
      "refuses a serialized choice with a %s private claim at the shipped execution entry",
      async (journal) => {
        bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
        const { repositoryPath, stateDirectory } = await repository();
        const stopped = await run(runRequest(repositoryPath), stateDirectory);
        const selected = await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText: "Use the implementation",
        });
        expect(selected.kind).toBe("choice");
        if (selected.kind !== "choice") return;
        if (journal !== "missing") {
          const {
            schemaVersion: _version,
            kind: _kind,
            choiceSha256: _digest,
            ...body
          } = selected.plan.choices.at(-1)!;
          await new FirstPassChoiceClaimStore(stateDirectory).claim({
            choice: createFirstPassChoice({
              ...body,
              ...(journal === "foreign"
                ? { sourceRunId: "foreign-source-run" }
                : journal === "wrong"
                  ? { successorRunId: "another-successor-run" }
                  : {}),
            }),
            childExists: async () => false,
          });
          if (journal === "foreign-owner" || journal === "unknown-owner") {
            const path = join(
              dirname(stateDirectory),
              "first-pass-choice-claims",
              `${sha(stopped.result!.id)}.0.json`,
            );
            const event = JSON.parse(await readFile(path, "utf8"));
            if (journal === "foreign-owner") event.ownerHost = "foreign-fixture-host";
            else event.ownerBirthIdentity = null;
            await writeFile(path, `${JSON.stringify(event)}\n`);
          }
        }
        await expect(
          executeRunRequest(
            liveAgentWorkflowRunRequest({
              repositoryPath,
              allowWrite: true,
              workflow: selected.plan.workflow,
              instruction: selected.plan.instruction,
              revision: selected.plan.revision,
              firstPassChoices: selected.plan.choices,
              runId: selected.plan.choices.at(-1)!.successorRunId,
            }),
            stubConfig(stateDirectory),
          ),
        ).rejects.toThrow(
          `The saved first-pass choice cannot continue this run (${journal === "wrong" ? "tampered" : "ineligible"}).`,
        );
        expect(capture.invocations).toHaveLength(0);
        expect(await savedRunIds(stateDirectory)).toEqual([stopped.result!.id]);
      },
    );

    it.each(["implementation", "exact", "context", "failed persistence"] as const)(
      "accepts the %s reply through the assembled live host after its saved terminal question",
      async (replyKind) => {
        bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
        const { repositoryPath, stateDirectory } = await repository();
        const config = stubConfig(stateDirectory);
        if (replyKind === "failed persistence") {
          vi.spyOn(LiveWorkflowDelivery.prototype, "persist").mockImplementation(async (record) =>
            record.status === "succeeded"
              ? { status: "failed", error: LIVE_DELIVERY_FAILURES.apply }
              : { status: "not-needed" },
          );
        }
        const dispatched: RunRecord[] = [];
        const host = await assembleLiveAgentHost({
          repositoryPath,
          allowWrite: true,
          environment: { PATH: process.env.PATH, NO_COLOR: "1" },
          config,
          capabilities: await loadLiveAgentCapabilities(config),
          sourcePorts: {} as never,
          onNotice: () => undefined,
          writeError: () => undefined,
          runWorkflow: async (request) => {
            const record = (await executeRunRequest(liveAgentWorkflowRunRequest(request), config, {
              requestInterpreter: admitPages(request.workflow),
            })) as RunRecord;
            dispatched.push(record);
            capture.completeFrom = record;
            return record;
          },
        });
        const tool = host.customTools.find(
          (candidate) => candidate.name === "docsfab_run_workflow",
        )!;
        const prompt = vi.fn(async () => {
          await tool.execute(
            "first-pass-stop",
            {
              workflow: "create-documentation",
              instruction: CREATE_SERVICE_PORT,
              ...(replyKind === "context"
                ? { context: "The conversation requested a local developer guide." }
                : {}),
            } as never,
            undefined,
            undefined,
            {} as never,
          );
        });
        const input = new PassThrough();
        const output = new PassThrough();
        let transcript = "";
        output.on("data", (chunk) => {
          transcript += chunk.toString();
        });
        const done = runTerminalConversation(
          { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
          input,
          output,
          { ...host.terminalOptions, environment: { NO_COLOR: "1" } },
        );
        input.write(`${CREATE_SERVICE_PORT}\n`);
        await vi.waitFor(() => expect(transcript).toContain("Recommended: Withhold"), {
          timeout: JOURNEY_MS,
        });
        const stopped = dispatched[0]!;
        expect(stopped.firstPassContradictionAdmission?.outcome).toBe("repository-only");
        const parentBytes = await readFile(join(stateDirectory, `${stopped.id}.json`), "utf8");
        const field = decodeRunRecordFirstPassContradiction(stopped.firstPassContradiction);
        input.write(`${field.question.recommendedDefault}\n`);
        await vi.waitFor(
          () =>
            expect(
              transcript.includes("not mapped precisely enough") || prompt.mock.calls.length > 1,
            ).toBe(true),
          { timeout: JOURNEY_MS },
        );
        expect(transcript).toContain("not mapped precisely enough");
        expect(dispatched).toHaveLength(1);
        const reply =
          replyKind === "implementation"
            ? "Use the implementation: 8088 from src/server.ts."
            : field.question.options.find((option) => option.includes("src/server.ts"))!;
        input.write(`${reply}\n`);
        await vi.waitFor(
          () =>
            expect(
              transcript.includes("operator-choice:") ||
                transcript.includes("[Failed]") ||
                prompt.mock.calls.length > 1,
            ).toBe(true),
          { timeout: JOURNEY_MS },
        );
        expect(transcript).toContain("operator-choice:");
        input.end();
        await done;
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(dispatched).toHaveLength(2);
        expect(dispatched[1]).toMatchObject({ status: "succeeded" });
        expect(dispatched[1]!.instructionContext).toBe(stopped.instructionContext);
        expect(dispatched[1]!.firstPassChoices).toHaveLength(1);
        expect(transcript).toContain("attributed operator choice");
        if (replyKind === "failed persistence") {
          expect(host.workflowFailure.blocking).toMatchObject({
            status: "failed",
            persistence: "failed",
          });
          expect(transcript).toContain("[Failed]");
          expect(transcript).not.toContain("[Completed]");
        }
        expect(await readFile(join(stateDirectory, `${stopped.id}.json`), "utf8")).toBe(
          parentBytes,
        );
        expect(JSON.stringify(dispatched[1])).not.toContain(reply);
        if (replyKind !== "failed persistence") {
          host.terminalOptions.onUserTurn?.("Inspect the latest saved result.");
          const read = host.customTools.find((tool) => tool.name === "docsfab_read_run");
          if (!read) throw new Error("The assembled host omitted its saved-run reader.");
          await expect(
            read.execute(
              "continued-run",
              { runId: dispatched[1]!.id },
              undefined,
              undefined,
              {} as never,
            ),
          ).resolves.toMatchObject({ details: { runId: dispatched[1]!.id } });
          expect(() =>
            read.execute(
              "unrelated-run",
              { runId: "unrelated-run" },
              undefined,
              undefined,
              {} as never,
            ),
          ).toThrow(DOCUMENTATION_WORK_REFUSAL);
        }
        const claimBytes = await readFile(
          join(dirname(stateDirectory), "first-pass-choice-claims", `${sha(stopped.id)}.0.json`),
          "utf8",
        );
        expect(claimBytes).not.toContain(reply);
        expect(JSON.parse(claimBytes).choice).toMatchObject({
          sourceRunId: stopped.id,
          successorRunId: dispatched[1]!.id,
        });
      },
    );

    it.each([
      ["same session", "original claims"],
      ["reopened session", "original claims"],
      ["same session", "split claims and legacy intent"],
      ["reopened session", "split claims and legacy intent"],
      ["same session", "split claims plus unresolved code"],
      ["reopened session", "split claims plus unresolved code"],
    ] as const)(
      "continues the byte-exact W0 source option with its original live context in the %s with %s",
      async (mode, claims) => {
        const offline = process.env.PI_OFFLINE;
        process.env.PI_OFFLINE = "0"; // Every model port below is injected; no live provider is constructed.
        try {
          const fixture = inputs.fixtureRoot;
          const data = JSON.parse(await readFile(join(fixture, "cases.json"), "utf8"));
          const qa = data.export;
          const files: Record<string, string> = {};
          for (const [name, digest] of Object.entries(data.provenance[inputs.exportDigestKey])) {
            const from =
              name === ".docsfab.json"
                ? "project-config.json.fixture"
                : `${inputs.repositoryDirectory}/${name}${/\.[cm]?[jt]s$/u.test(name) ? ".fixture" : ""}`;
            files[name] = await readFile(join(fixture, from), "utf8");
            expect(sha(files[name]!)).toBe(digest);
          }
          const { repositoryPath, stateDirectory } = await repository(
            files,
            true,
            {},
            files[".docsfab.json"],
          );
          const original = qa.firstPassContradiction.contradictions[0];
          // Produce a historical saved stop before enabling source-comment classification.
          const legacyRoles = vi
            .spyOn(sourceQuotationRoles, "sourceCommentQuotationReader")
            .mockReturnValue(() => false);
          bridgeHolder.bridge = contradictionBridge(
            (seeds, frames) => {
              const source = frameWith(frames, "src/export.ts", original.sides[1].value);
              return seeds.map((seed) =>
                seed.id === original.obligationId
                  ? {
                      obligationId: seed.id,
                      status: "contradicted",
                      evidenceSpanIds: [source.id],
                      sides: original.sides.map((side: { value: string }) => ({
                        spanId: source.id,
                        value: side.value,
                      })),
                      detail: "The retained header comment and implementation disagree.",
                    }
                  : {
                      obligationId: seed.id,
                      status: "supported",
                      evidenceSpanIds: seed.requiredSourceSupport ? [source.id] : [],
                      detail: "The exact implementation provides the function evidence.",
                    },
              );
            },
            [
              {
                id: original.obligationId,
                origin: "explicit",
                instructionQuote: original.condition,
                targetPaths: original.targetPaths,
                condition: original.condition,
                requiredSourceSupport: true,
              },
            ],
          );
          const intent = qa.requestIntent.intent;
          const interpreter: RequestIntentInterpreterPort = {
            call: async () => ({
              text: JSON.stringify({
                operation: "create",
                targets: intent.targets.map((target: any) => ({
                  ...target,
                  quote: target.quote.text,
                })),
                sources: intent.sources.map((source: any) => ({
                  ...source,
                  quote: source.quote.text,
                })),
                authorityPreference: {
                  preference: intent.authorityPreference.preference,
                  quote: intent.authorityPreference.quote.text,
                },
              }),
              usage: { inputTokens: 3, outputTokens: 2 },
            }),
          };
          const config = stubConfig(stateDirectory);
          // The imported historical record must not inherit the producer's
          // modern private replay seal from a sibling state directory.
          const historicalStateDirectory = join(
            dirname(stateDirectory),
            "historical-stops",
            "runs",
          );
          const sessions = join(dirname(stateDirectory), "sessions");
          await mkdir(sessions, { recursive: true });
          const manager = SessionManager.create(repositoryVirtualCwd(repositoryPath), sessions);
          const dispatched: RunRecord[] = [];
          const legacyIntent = claims !== "original claims";
          const capabilities = await loadLiveAgentCapabilities(config);
          const makeHost = (sessionManager: SessionManager) =>
            assembleLiveAgentHost({
              repositoryPath,
              allowWrite: true,
              sessionManager,
              sessionDirectory: sessions,
              environment: { PATH: process.env.PATH, NO_COLOR: "1" },
              config,
              capabilities,
              sourcePorts: {} as never,
              onNotice: () => undefined,
              writeError: () => undefined,
              runWorkflow: async (request) => {
                const historicalStop = legacyIntent && dispatched.length === 0;
                let record = (await executeRunRequest(
                  liveAgentWorkflowRunRequest(request),
                  historicalStop ? { ...config, stateDirectory: historicalStateDirectory } : config,
                  { requestInterpreter: interpreter },
                )) as RunRecord;
                if (historicalStop) {
                  expect(record.requestIntent?.intent?.digest).toBe(intent.digest);
                  // Import a historical public record into this host's empty store.
                  // A fresh FileRunStore must never overwrite another store's record.
                  record = {
                    ...record,
                    // A historical stop predates the producer-private replay seal.
                    // Its public record must not carry a modern replay capsule.
                    firstPassReplay: undefined,
                    requestIntent: {
                      schemaVersion: 1,
                      admission: {
                        outcome: "offline",
                        code: null,
                        location: null,
                        reason: "pi-offline",
                        boundary: null,
                        calls: [],
                        clippedTitles: 0,
                      },
                      intent: null,
                    },
                  };
                  const { FileRunStore } = await import("../src/records/file-store.js");
                  await new FileRunStore(stateDirectory).save(record);
                }
                dispatched.push(record);
                capture.completeFrom = record;
                return record;
              },
            });
          const first = await makeHost(manager);
          first.terminalOptions.onUserTurn?.(qa.instruction);
          await first.customTools
            .find((tool) => tool.name === "docsfab_run_workflow")!
            .execute(
              "w0-original",
              {
                workflow: "create-documentation",
                instruction: qa.instruction,
                context: qa.instructionContext,
              } as never,
              undefined,
              undefined,
              {} as never,
            );
          const stopped = dispatched[0]!;
          legacyRoles.mockRestore();
          expect(stopped).toMatchObject({
            status: "needs-input",
            error: "contradicted",
            instruction: qa.instruction,
            instructionContext: qa.instructionContext,
            firstPassContradictionAdmission: { outcome: "repository-only" },
          });
          if (legacyIntent) {
            expect(stopped.requestIntent!.intent).toBeNull();
            expect(stopped.firstPassReplay).toBeUndefined();
          } else expect(stopped.requestIntent?.intent?.digest).toBe(intent.digest);
          const preservedIntent = structuredClone(stopped.requestIntent);
          const field = decodeRunRecordFirstPassContradiction(stopped.firstPassContradiction);
          expect(field).toEqual(qa.firstPassContradiction);
          const successorModelCall = vi.fn(async () => {
            throw new Error("The frozen assessment must not invoke the model again.");
          });
          const legacyBridge = legacyIntent
            ? splitExportBridge(claims === "split claims plus unresolved code")
            : undefined;
          bridgeHolder.bridge = legacyBridge ?? {
            call: successorModelCall,
            lastAssessmentIdentitySha256: () => undefined,
            lastAssessmentBindingSha256: () => undefined,
          };
          const parentPath = join(stateDirectory, `${stopped.id}.json`);
          const parentBytes = await readFile(parentPath, "utf8");
          first.terminalOptions.turnNotices?.();
          manager.appendMessage({
            role: "assistant",
            content: "The saved first-pass source options are pending.",
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          } as never);
          const active =
            mode === "reopened session"
              ? await makeHost(
                  SessionManager.continueRecent(repositoryVirtualCwd(repositoryPath), sessions),
                )
              : first;
          expect(active.terminalOptions.hasPendingFirstPassChoice?.()).toBe(true);
          const input = new PassThrough();
          const output = new PassThrough();
          let transcript = "";
          output.on("data", (chunk) => {
            transcript += chunk.toString();
          });
          const prompt = vi.fn(async () => undefined);
          const done = runTerminalConversation(
            { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
            input,
            output,
            { ...active.terminalOptions, environment: { NO_COLOR: "1" } },
          );
          const option = field.question.options[1]!;
          input.write(`${option}\n`);
          await vi.waitFor(
            () =>
              expect(
                transcript.includes("operator-choice:") ||
                  transcript.includes("[Failed]") ||
                  dispatched.length === 2 ||
                  prompt.mock.calls.length > 0,
              ).toBe(true),
            { timeout: JOURNEY_MS },
          );
          input.end();
          await done;
          expect(prompt).not.toHaveBeenCalled();
          expect(dispatched).toHaveLength(2);
          const unresolved = claims === "split claims plus unresolved code";
          expect(dispatched[1]).toMatchObject({
            status: unresolved ? "needs-input" : "succeeded",
            instruction: qa.instruction,
            instructionContext: qa.instructionContext,
          });
          expect(dispatched[1]!.firstPassChoices).toHaveLength(1);
          expect(dispatched[1]!.requestIntent).toEqual(preservedIntent);
          expect(dispatched[1]!.firstPassChoices![0]!.obligationId).toBe(original.obligationId);
          if (claims !== "original claims") {
            if (unresolved) {
              expect(dispatched[1]!.steps).toEqual([]);
              const remaining = decodeRunRecordFirstPassContradiction(
                dispatched[1]!.firstPassContradiction,
              );
              expect(remaining.contradictions.map((claim) => claim.obligationId)).toEqual([
                "decomposed-unimplemented-command-comment",
              ]);
            } else {
              const warnings = dispatched[1]!.evidenceWarnings!.join("\n");
              expect(warnings).toContain("docs-stale:");
              expect(warnings).toContain("decomposed-no-file-write");
              expect(warnings).toContain("decomposed-unimplemented-command-comment");
            }
            expect(dispatched[1]!.requestIntent!.intent).toBeNull();
          }
          expect(capture.invocations).toHaveLength(unresolved ? 0 : 1);
          if (!unresolved) {
            expect(capture.invocations[0]!.request.requestIntent).toEqual(preservedIntent);
            expect(capture.invocations[0]!.request.instructionContext).toEqual(
              stopped.instructionContext,
            );
          }
          expect(successorModelCall).not.toHaveBeenCalled();
          if (legacyBridge) expect(legacyBridge.prompts.length).toBeGreaterThan(0);
          expect(await readFile(parentPath, "utf8")).toBe(parentBytes);
        } finally {
          if (offline === undefined) delete process.env.PI_OFFLINE;
          else process.env.PI_OFFLINE = offline;
        }
      },
    );

    it.each([
      ["ordinary documentation", null, null],
      ["legal rights metadata", "// All rights are reserved.", "All rights are reserved."],
      ["coverage directive", "/* node:coverage ignore next */", "node:coverage ignore next"],
      [
        "inspection directive",
        "// noinspection JSUnusedGlobalSymbols",
        "noinspection JSUnusedGlobalSymbols",
      ],
    ] as const)(
      "keeps fresh export source roles for %s",
      async (_kind, metadataLine, metadataQuote) => {
        const offline = process.env.PI_OFFLINE;
        process.env.PI_OFFLINE = "0"; // All model ports are injected, including interpretation.
        try {
          const fixture = inputs.fixtureRoot;
          const data = JSON.parse(await readFile(join(fixture, "cases.json"), "utf8"));
          const qa = data.export;
          const files: Record<string, string> = {};
          for (const [name, digest] of Object.entries(data.provenance[inputs.exportDigestKey])) {
            const from =
              name === ".docsfab.json"
                ? "project-config.json.fixture"
                : `${inputs.repositoryDirectory}/${name}${/\.[cm]?[jt]s$/u.test(name) ? ".fixture" : ""}`;
            files[name] = await readFile(join(fixture, from), "utf8");
            expect(sha(files[name]!)).toBe(digest);
          }
          if (metadataLine !== null)
            files["src/export.ts"] = [
              metadataLine,
              ...files["src/export.ts"]!.split("\n").slice(1),
            ].join("\n");
          const { repositoryPath, stateDirectory } = await repository(
            files,
            true,
            {},
            files[".docsfab.json"],
          );
          bridgeHolder.bridge = splitExportBridge(false, metadataQuote ?? undefined);
          const intent = qa.requestIntent.intent;
          const result = await run(
            runRequest(repositoryPath, true, "create-documentation", qa.instruction),
            stateDirectory,
            {
              call: async () => ({
                text: JSON.stringify({
                  operation: "create",
                  targets: intent.targets.map((target: any) => ({
                    ...target,
                    quote: target.quote.text,
                  })),
                  sources: intent.sources.map((source: any) => ({
                    ...source,
                    quote: source.quote.text,
                  })),
                  authorityPreference: {
                    preference: intent.authorityPreference.preference,
                    quote: intent.authorityPreference.quote.text,
                  },
                }),
                usage: { inputTokens: 3, outputTokens: 2 },
              }),
            },
          );
          if (metadataQuote !== null) {
            expect(result.error).toBeUndefined();
            expect(result.result).toMatchObject({ status: "needs-input", error: "contradicted" });
            const stopped = decodeRunRecordFirstPassContradiction(
              result.result!.firstPassContradiction,
            );
            expect(stopped.contradictions.map((claim) => claim.obligationId)).toEqual([
              "decomposed-no-file-write",
            ]);
            expect(stopped.contradictions[0]!.sides[0]!.value).toBe(metadataQuote);
            expect(capture.invocations).toHaveLength(0);
            return;
          }
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toContain(STOP_AT_EXECUTION);
          expect(capture.invocations).toHaveLength(1);
          const invocation = capture.invocations[0]!;
          expect(invocation.request.firstPassChoices).toBeUndefined();
          const notices = invocation.firstPassNotices!.join("\n");
          expect(notices).toContain("docs-stale:");
          expect(notices).toContain("decomposed-no-file-write");
          expect(notices).toContain("decomposed-unimplemented-command-comment");
          expect(await savedRunIds(stateDirectory)).toEqual([]);
        } finally {
          if (offline === undefined) delete process.env.PI_OFFLINE;
          else process.env.PI_OFFLINE = offline;
        }
      },
    );

    it.each(["unvalued", "reassessed values"] as const)(
      "continues an exact nullable source option after reopening with %s",
      async (reassessment) => {
        bridgeHolder.bridge = contradictionBridge((seeds, frames) =>
          contradictedRows(PORT_SIDES)(seeds, frames).map((row) => ({ ...row, sides: undefined })),
        );
        const { repositoryPath, stateDirectory } = await repository();
        const config = stubConfig(stateDirectory);
        const sessionDirectory = join(dirname(stateDirectory), "sessions");
        await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
        const manager = SessionManager.create(
          repositoryVirtualCwd(repositoryPath),
          sessionDirectory,
        );
        const dispatched: RunRecord[] = [];
        const capabilities = await loadLiveAgentCapabilities(config);
        const makeHost = (sessionManager: SessionManager) =>
          assembleLiveAgentHost({
            repositoryPath,
            allowWrite: true,
            sessionManager,
            sessionDirectory,
            environment: { PATH: process.env.PATH, NO_COLOR: "1" },
            config,
            capabilities,
            sourcePorts: {} as never,
            onNotice: () => undefined,
            writeError: () => undefined,
            runWorkflow: async (request) => {
              const record = (await executeRunRequest(
                liveAgentWorkflowRunRequest(request),
                config,
                {
                  requestInterpreter: admitPages(request.workflow),
                },
              )) as RunRecord;
              dispatched.push(record);
              capture.completeFrom = record;
              return record;
            },
          });
        const firstHost = await makeHost(manager);
        firstHost.terminalOptions.onUserTurn?.(CREATE_SERVICE_PORT);
        await firstHost.customTools
          .find((candidate) => candidate.name === "docsfab_run_workflow")!
          .execute(
            "saved-first-pass-stop",
            { workflow: "create-documentation", instruction: CREATE_SERVICE_PORT } as never,
            undefined,
            undefined,
            {} as never,
          );
        const parent = dispatched[0]!;
        const parentPath = join(stateDirectory, `${parent.id}.json`);
        const parentBytes = await readFile(parentPath, "utf8");
        const field = decodeRunRecordFirstPassContradiction(parent.firstPassContradiction);
        const option = field.question.options.find((entry) => entry.includes("src/server.ts"))!;
        expect(field.contradictions[0]!.sides.every((side) => side.value === null)).toBe(true);
        firstHost.terminalOptions.turnNotices?.();
        manager.appendMessage({
          role: "assistant",
          content: "The workflow stopped and offered its source options.",
          api: "openai-completions",
          provider: "fixture",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as never);
        const reopened = SessionManager.continueRecent(
          repositoryVirtualCwd(repositoryPath),
          sessionDirectory,
        );
        expect(reopened.getSessionId()).toBe(manager.getSessionId());
        expect(restoreLocalContinuation(reopened, repositoryPath)?.pending_first_pass_run_id).toBe(
          parent.id,
        );
        const resumedHost = await makeHost(reopened);
        expect(resumedHost.terminalOptions.hasPendingFirstPassChoice?.()).toBe(true);
        const input = new PassThrough();
        const output = new PassThrough();
        let transcript = "";
        output.on("data", (chunk) => {
          transcript += chunk.toString();
        });
        const prompt = vi.fn(async () => undefined);
        const done = runTerminalConversation(
          { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
          input,
          output,
          { ...resumedHost.terminalOptions, environment: { NO_COLOR: "1" } },
        );
        if (reassessment === "reassessed values")
          bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
        input.write(`${option}\n`);
        await vi.waitFor(
          () =>
            expect(
              transcript.includes("operator-choice:") ||
                transcript.includes("[Failed]") ||
                prompt.mock.calls.length > 0,
            ).toBe(true),
          { timeout: JOURNEY_MS },
        );
        input.end();
        await done;
        expect(prompt).not.toHaveBeenCalled();
        expect(dispatched).toHaveLength(2);
        expect(dispatched[1]).toMatchObject({ status: "succeeded" });
        expect(dispatched[1]!.firstPassChoices).toHaveLength(1);
        expect(await readFile(parentPath, "utf8")).toBe(parentBytes);
        const claimBytes = await readFile(
          join(dirname(stateDirectory), "first-pass-choice-claims", `${sha(parent.id)}.0.json`),
          "utf8",
        );
        expect(claimBytes).not.toContain(option);
        expect(
          restoreLocalContinuation(reopened, repositoryPath)?.pending_first_pass_run_id,
        ).toBeUndefined();
        // Ordinary history keeps its existing messages; the new locator grants no authority.
        expect(
          restoreLocalContinuation(reopened, repositoryPath)?.continuation.operatorMessages,
        ).toEqual([CREATE_SERVICE_PORT, option]);
      },
    );

    it("admits only a newly marked repository-only stop and its exact offered side", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      const field = decodeRunRecordFirstPassContradiction(stopped.result!.firstPassContradiction);
      const exact = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: field.question.options.find((option) => option.includes("src/server.ts"))!,
      });
      expect(exact.kind).toBe("choice");
      const unrelated = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: "Create docs/other.md for another task",
      });
      expect(unrelated).toEqual({ kind: "routing" });
      const unrelatedUse = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: "Use the example to create docs/other.md for a new task",
      });
      expect(unrelatedUse).toEqual({ kind: "routing" });
      const withhold = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: field.question.recommendedDefault,
      });
      expect(withhold).toMatchObject({ kind: "refused" });
      const raw = JSON.parse(
        await readFile(join(stateDirectory, `${stopped.result!.id}.json`), "utf8"),
      );
      delete raw.firstPassContradictionAdmission;
      await writeFile(
        join(stateDirectory, `${stopped.result!.id}.json`),
        `${JSON.stringify(raw)}\n`,
      );
      const legacy = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: "Use the implementation",
      });
      expect(legacy).toMatchObject({ kind: "refused" });
    });

    it("marks a source-attached first-pass stop ineligible for offered-answer replay", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(
        { ...runRequest(repositoryPath), sourcePaths: ["src/server.ts"] },
        stateDirectory,
      );
      expect(stopped.result?.status).toBe("needs-input");
      expect(stopped.result?.firstPassContradictionAdmission?.outcome).toBe(
        "external-binding-unsupported",
      );
      expect((await savedContradiction(stateDirectory, stopped.result!.id)).record.id).toBe(
        stopped.result!.id,
      );
      expect(stopped.result?.firstPassReplay).toBeUndefined();
      const reply = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: "Use the implementation",
      });
      expect(reply).toMatchObject({ kind: "refused" });
      expect(await savedRunIds(stateDirectory)).toEqual([stopped.result!.id]);
    });

    it("refuses foreign, tampered, credential-bearing, and changed-revision replies before a successor", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      const answer = "Use the implementation";
      const foreignRepo = (await repository()).repositoryPath;
      expect(
        await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath: foreignRepo,
          pendingRunId: stopped.result!.id,
          replyText: answer,
        }),
      ).toMatchObject({ kind: "refused" });
      const secret = configureCredential("synthetic-first-pass-choice-secret");
      expect(
        await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText: `Use ${secret}`,
        }),
      ).toMatchObject({ kind: "refused" });
      const recordPath = join(stateDirectory, `${stopped.result!.id}.json`);
      const savedBytes = await readFile(recordPath, "utf8");
      const tampered = JSON.parse(savedBytes);
      tampered.firstPassContradiction.question.question = "Use unverified text";
      await writeFile(recordPath, `${JSON.stringify(tampered)}\n`);
      expect(
        await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText: answer,
        }),
      ).toMatchObject({ kind: "refused" });
      await writeFile(recordPath, savedBytes);
      await writeFile(
        join(repositoryPath, "src/server.ts"),
        "export const requiredListenPort = 8089;\n",
      );
      execFileSync("git", ["-C", repositoryPath, "add", "src/server.ts"]);
      execFileSync("git", [
        "-C",
        repositoryPath,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Changed port",
      ]);
      expect(
        await planLiveFirstPassChoice({
          stateDirectory,
          repositoryPath,
          pendingRunId: stopped.result!.id,
          replyText: answer,
        }),
      ).toMatchObject({ kind: "refused" });
      expect(await savedRunIds(stateDirectory)).toEqual([stopped.result!.id]);
    });

    it("keeps the second contradiction open and reuses the first attributed choice on the next answer", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES), [
        {
          id: "decomposed-second",
          origin: "inferred",
          instructionQuote: null,
          targetPaths: [TARGET],
          condition: "The second service port remains consistent.",
          requiredSourceSupport: true,
        },
      ]);
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      expect(stopped.result?.status).toBe("needs-input");
      const successorModelCall = vi.fn(async () => {
        throw new Error("A saved assessment must supply both pending choices.");
      });
      bridgeHolder.bridge = {
        call: successorModelCall,
        lastAssessmentIdentitySha256: () => undefined,
        lastAssessmentBindingSha256: () => undefined,
      };
      const firstQuestion = decodeRunRecordFirstPassContradiction(
        stopped.result!.firstPassContradiction,
      ).question;
      const first = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: firstQuestion.options.find(
          (option) => option.includes("target-01") && option.includes("src/server.ts"),
        )!,
      });
      expect(first.kind).toBe("choice");
      if (first.kind !== "choice") return;
      const runWorkflow = async (request: Parameters<typeof runBoundedWorkflow>[0]) =>
        (await executeRunRequest(liveAgentWorkflowRunRequest(request), request.config, {
          requestInterpreter: admitPages(request.workflow),
        })) as RunRecord;
      const middle = await continueLiveFirstPassChoice(first.plan, {
        repositoryPath,
        allowWrite: true,
        config: stubConfig(stateDirectory),
        persist: async () => ({ status: "not-needed" }),
        runWorkflow,
      });
      expect(middle.status).toBe("needs-input");
      expect(middle.firstPassChoices).toHaveLength(1);
      expect(middle.firstPassReplay?.replaySha256).toBe(
        stopped.result?.firstPassReplay?.replaySha256,
      );
      expect((await savedContradiction(stateDirectory, middle.id)).record.firstPassReplay).toEqual(
        middle.firstPassReplay,
      );
      const remaining = decodeRunRecordFirstPassContradiction(middle.firstPassContradiction);
      expect(remaining.contradictions.map((item) => item.obligationId)).toEqual([
        "decomposed-second",
      ]);
      const second = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: middle.id,
        replyText: remaining.question.options.find((option) => option.includes("src/server.ts"))!,
      });
      expect(second.kind).toBe("choice");
      if (second.kind !== "choice") return;
      capture.completeFrom = middle;
      const completed = await continueLiveFirstPassChoice(second.plan, {
        repositoryPath,
        allowWrite: true,
        config: stubConfig(stateDirectory),
        persist: async () => ({ status: "not-needed" }),
        runWorkflow,
      });
      expect(completed.status).toBe("succeeded");
      expect(completed.firstPassChoices?.map((choice) => choice.obligationId)).toEqual([
        "target-01",
        "decomposed-second",
      ]);
      expect(
        completed.evidenceWarnings?.filter((line) => line.startsWith("operator-choice:")),
      ).toHaveLength(2);
      expect(successorModelCall).not.toHaveBeenCalled();
    });

    it("keeps a legacy choice chain without replay after a second contradiction", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES), [
        {
          id: "decomposed-second",
          origin: "inferred",
          instructionQuote: null,
          targetPaths: [TARGET],
          condition: "The second service port remains consistent.",
          requiredSourceSupport: true,
        },
      ]);
      const { repositoryPath, stateDirectory } = await repository();
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      await removeReplayFromLegacyStop(stateDirectory, stopped.result!.id);
      const firstQuestion = decodeRunRecordFirstPassContradiction(
        stopped.result!.firstPassContradiction,
      ).question;
      const first = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: stopped.result!.id,
        replyText: firstQuestion.options.find(
          (option) => option.includes("target-01") && option.includes("src/server.ts"),
        )!,
      });
      expect(first.kind).toBe("choice");
      if (first.kind !== "choice") return;
      const runWorkflow = async (request: Parameters<typeof runBoundedWorkflow>[0]) =>
        (await executeRunRequest(liveAgentWorkflowRunRequest(request), request.config, {
          requestInterpreter: admitPages(request.workflow),
        })) as RunRecord;
      const middle = await continueLiveFirstPassChoice(first.plan, {
        repositoryPath,
        allowWrite: true,
        config: stubConfig(stateDirectory),
        persist: async () => ({ status: "not-needed" }),
        runWorkflow,
      });
      expect(middle.status).toBe("needs-input");
      expect(middle.firstPassReplay).toBeUndefined();
      const remaining = (await savedContradiction(stateDirectory, middle.id)).field;
      expect(remaining.contradictions.map((item) => item.obligationId)).toEqual([
        "decomposed-second",
      ]);
      const second = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: middle.id,
        replyText: remaining.question.options.find((option) => option.includes("src/server.ts"))!,
      });
      expect(second.kind).toBe("choice");
      if (second.kind !== "choice") return;
      capture.completeFrom = middle;
      const completed = await continueLiveFirstPassChoice(second.plan, {
        repositoryPath,
        allowWrite: true,
        config: stubConfig(stateDirectory),
        persist: async () => ({ status: "not-needed" }),
        runWorkflow,
      });
      expect(completed.status).toBe("succeeded");
      expect(completed.firstPassChoices?.map((choice) => choice.obligationId)).toEqual([
        "target-01",
        "decomposed-second",
      ]);
      expect(capture.invocations).toHaveLength(1);
    });

    it.each([
      {
        form: "line comment",
        source: '// Export format is "old".\nexport const exportFormat = "new";\n',
        commentLine: 1,
        implementationLine: 2,
      },
      {
        form: "code-shaped block comment",
        source: '/*\nexport const exportFormat = "old";\n*/\nexport const exportFormat = "new";\n',
        commentLine: 2,
        implementationLine: 4,
      },
      {
        form: "same-line comment",
        source: '/* export const exportFormat = "old"; */ export const exportFormat = "new";\n',
        commentLine: 1,
        implementationLine: 1,
      },
    ])("maps the implementation paraphrase past a $form in the same source", async (example) => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository({
        "src/export.ts": example.source,
      });
      const stopped = await run(runRequest(repositoryPath), stateDirectory);
      const recordPath = join(stateDirectory, `${stopped.result!.id}.json`);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      const obligationId = decodeRunRecordFirstPassContradiction(record.firstPassContradiction)
        .contradictions[0]!.obligationId;
      record.firstPassContradiction = firstPassContradictionRecord([
        {
          obligationId,
          targetPaths: [TARGET],
          condition: "The export format agrees with its implementation.",
          sides: [
            {
              path: "src/export.ts",
              lineStart: example.commentLine,
              lineEnd: example.commentLine,
              value: "old",
            },
            {
              path: "src/export.ts",
              lineStart: example.implementationLine,
              lineEnd: example.implementationLine,
              value: "new",
            },
          ],
        },
      ]);
      record.firstPassContradictionAdmission = firstPassContradictionAdmission({
        runId: record.id,
        repositoryRevision: record.repository.revision,
        instruction: record.instruction,
        contradiction: record.firstPassContradiction,
      });
      await writeFile(recordPath, `${JSON.stringify(record)}\n`);
      const selected = await planLiveFirstPassChoice({
        stateDirectory,
        repositoryPath,
        pendingRunId: record.id,
        replyText: 'Use the implementation: "new" from src/export.ts.',
      });
      expect(selected.kind).toBe("choice");
      if (selected.kind !== "choice") return;
      expect(selected.plan.choices.at(-1)?.optionIndex).toBe(1);
    });

    it("stops the 9090-versus-8088 update with code contradicted, a needs-input record and one question (Acceptance 2)", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(runRequest(repositoryPath), stateDirectory);
      expect(outcome.error, String(outcome.error)).toBeUndefined();
      expect(capture.invocations, "the run reached workflow execution").toHaveLength(0);
      const stopped = outcome.result!;
      expect(stopped.status).toBe("needs-input");
      expect(stopped.error).toBe("contradicted");
      expect(stopped.steps).toEqual([]);
      expect(process.exitCode).toBe(2);
      expect(stopped.requestIntent?.admission.outcome).toBe("admitted");

      // Read back through the shipped reader and decoder.
      const { record, field } = await savedContradiction(stateDirectory, stopped.id);
      expect(record.status).toBe("needs-input");
      expect(record.firstPassContradictionAdmission?.reasons).toEqual([]);
      expect(record.firstPassContradictionAdmission).toMatchObject({
        kind: "docsfab-first-pass-contradiction-admission",
        outcome: "repository-only",
        runId: stopped.id,
        repositoryRevision: record.repository.revision,
      });
      expect(field.code).toBe("contradicted");
      expect(field.contradictions.length).toBeGreaterThan(0);
      for (const contradiction of field.contradictions) {
        expect(contradiction.targetPaths).toContain(TARGET);
        expect(contradiction.targetPaths).not.toEqual([OPERATIONS]);
        expect(contradiction.sides.map((side) => [side.path, side.value])).toEqual([
          ["deploy.yaml", "9090"],
          ["src/server.ts", "8088"],
        ]);
      }
      const { question } = field;
      for (const fact of ["9090", "8088", "deploy.yaml", "src/server.ts"]) {
        expect(question.question, fact).toContain(fact);
      }
      expect(question.question).toContain("Do you know of anything outside what I can see");
      expect(question.options.filter((option) => option.includes("9090"))).toHaveLength(
        field.contradictions.length,
      );
      expect(question.options.filter((option) => option.includes("8088"))).toHaveLength(
        field.contradictions.length,
      );
      expect(question.options.at(-1)).toBe(question.recommendedDefault);
      expect(question.recommendedDefault).toBe(
        "Withhold the disputed section until the sources agree",
      );
      expect(question.consequence).toContain(TARGET);
      expect(JSON.stringify(field)).not.toMatch(/install/iu);

      // NEXT in runs show, human and --json, carries the same question.
      const human = (await runsShow(stopped.id, stateDirectory, false)).join("\n");
      expect(human).toContain("FIRST PASS");
      expect(human).toContain(`Question: ${question.question}`);
      expect(human).toContain(`Recommended: ${question.recommendedDefault}`);
      expect(human).toContain('Side: deploy.yaml lines 1-5 · "9090"');
      expect(human).not.toContain("This preflight did not create a RunRecord");
      const shown = JSON.parse(
        (await runsShow(stopped.id, stateDirectory, true)).at(-1) ?? "{}",
      ) as {
        execution: { status: string; exitCode: number };
        nextSteps: string[];
      };
      expect(shown.execution.status).toBe("needs-input");
      expect(shown.nextSteps.join("\n")).toContain(`Question: ${question.question}`);
    });

    it("prints the stop as a RunResult with --json, never the error envelope", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(runRequest(repositoryPath, true), stateDirectory);
      expect(outcome.error, String(outcome.error)).toBeUndefined();
      const result = JSON.parse(outcome.logs.at(-1) ?? "{}") as {
        kind: string;
        execution: { runId: string; status: string; exitCode: number };
        nextSteps: string[];
      };
      expect(result.kind).toBe("docsfab-run-result");
      expect(result.execution).toMatchObject({
        status: "needs-input",
        exitCode: 2,
      });
      const { field } = await savedContradiction(stateDirectory, result.execution.runId);
      expect(result.nextSteps.join("\n")).toContain(`Question: ${field.question.question}`);
    });

    it("keeps first pass's notice for a source the reading names that it did not bind on the stop record (#2112)", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(
        runRequest(repositoryPath),
        stateDirectory,
        admitPages("update-documentation", [
          { path: "upstream", quote: "the repository evidence" },
        ]),
      );
      expect(outcome.error, String(outcome.error)).toBeUndefined();
      expect(outcome.result).toMatchObject({ status: "needs-input", error: "contradicted" });
      const notice =
        'first-pass-reading-source-unbound: "upstream" (not-tracked): the request\'s reading names it as a source, but the selected revision tracks no regular file at that path or under it, so first pass did not read it and went on with the evidence it could bind. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.';
      const { record } = await savedContradiction(stateDirectory, outcome.result!.id);
      expect(record.evidenceWarnings).toEqual([notice]);
      const human = (await runsShow(outcome.result!.id, stateDirectory, false)).map((line) =>
        line.trim(),
      );
      expect(human).toContain("LIMITATIONS");
      expect(human).toContain(notice);
    });

    it("stops a create the same way: first pass always runs for a create", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(
        runRequest(repositoryPath, false, "create-documentation"),
        stateDirectory,
      );
      expect(outcome.error, String(outcome.error)).toBeUndefined();
      expect(capture.invocations).toHaveLength(0);
      expect(outcome.result).toMatchObject({
        status: "needs-input",
        error: "contradicted",
      });
      const { field } = await savedContradiction(stateDirectory, outcome.result!.id);
      expect(field.contradictions.every((item) => item.targetPaths.includes(NEW_PAGE))).toBe(true);
      expect(field.question.question).toContain("9090");
      expect(field.question.question).toContain("8088");
    });

    it("names paths and lines but no value when the assessment gave no sides", async () => {
      bridgeHolder.bridge = contradictionBridge(contradictedRows(() => undefined));
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(runRequest(repositoryPath), stateDirectory);
      expect(outcome.error, String(outcome.error)).toBeUndefined();
      const { field } = await savedContradiction(stateDirectory, outcome.result!.id);
      for (const contradiction of field.contradictions) {
        expect(contradiction.sides.map((side) => [side.path, side.value])).toEqual([
          ["deploy.yaml", null],
          ["src/server.ts", null],
        ]);
      }
      expect(field.question.question).toContain("`deploy.yaml` line");
      expect(field.question.question).toContain("`src/server.ts` line");
      expect(field.question.question).not.toMatch(/9090|8088/u);
    });

    it("never puts a value the span does not hold in the question (V1)", async () => {
      // The model says src/server.ts has 8080; its span holds 8088.
      bridgeHolder.bridge = contradictionBridge(
        contradictedRows((frames) => [
          {
            spanId: frameWith(frames, "deploy.yaml", "9090").id,
            value: "9090",
          },
          {
            spanId: frameWith(frames, "src/server.ts", "8088").id,
            value: "8080",
          },
        ]),
      );
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(runRequest(repositoryPath), stateDirectory);
      expect(outcome.error, String(outcome.error)).toBeUndefined();
      const { field } = await savedContradiction(stateDirectory, outcome.result!.id);
      expect(JSON.stringify(field)).not.toContain("8080");
      for (const contradiction of field.contradictions) {
        expect(contradiction.sides.every((side) => side.value === null)).toBe(true);
      }
    });

    it("keeps insufficient-evidence and saves no record when a real gap sits beside the contradiction", async () => {
      // Adjacent condition: a missing obligation is an evidence gap, not a question.
      bridgeHolder.bridge = contradictionBridge(
        contradictedRows(PORT_SIDES, undefined, (seed) =>
          seed.id === "decomposed-health-probe"
            ? {
                status: "missing",
                evidenceSpanIds: [],
                detail: "No health probe source was offered.",
              }
            : undefined,
        ),
        [
          {
            id: "decomposed-health-probe",
            origin: "inferred",
            instructionQuote: null,
            targetPaths: [TARGET],
            condition: "An example health probe for the service is documented.",
            requiredSourceSupport: true,
          },
        ],
      );
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(runRequest(repositoryPath), stateDirectory);
      expect(outcome.error).toBeInstanceOf(FirstPassSupportValidationError);
      const error = outcome.error as FirstPassSupportValidationError;
      expect(error.code).toBe("insufficient-evidence");
      expect(error.contradictions).toBeUndefined();
      const statuses = new Map(error.details.map((item) => [item.id, item.status]));
      expect(statuses.get("decomposed-health-probe")).toBe("missing");
      expect([...statuses.values()]).toContain("contradicted");
      expect(await savedRunIds(stateDirectory)).toEqual([]);
      expect(toOperatorErrorEnvelope(outcome.error).code).toBe("insufficient-evidence");
    });

    it("keeps insufficient-evidence, led by the source it could not read, when the request names a missing source beside the contradiction", async () => {
      // Adjacent condition: the operator named the authority, and first pass never read it.
      bridgeHolder.bridge = contradictionBridge(contradictedRows(PORT_SIDES));
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(
        runRequest(
          repositoryPath,
          false,
          "update-documentation",
          `${CONFLICTING_SERVICE_PORT} The authoritative port is in config/ports.md.`,
        ),
        stateDirectory,
      );
      expect(outcome.error).toBeInstanceOf(FirstPassSupportValidationError);
      const error = outcome.error as FirstPassSupportValidationError;
      expect(error.code).toBe("insufficient-evidence");
      expect(error.contradictions).toBeUndefined();
      expect(error.message).toMatch(
        /^The request names sources first pass could not read: config\/ports\.md /u,
      );
      expect(error.nextAction).toMatch(/^Check each source the request names/u);
      expect(error.details.map((item) => item.status)).toContain("contradicted");
      expect(await savedRunIds(stateDirectory)).toEqual([]);
      expect(capture.invocations).toHaveLength(0);
    });

    it("reaches workflow execution when the sources agree (positive control)", async () => {
      bridgeHolder.bridge = contradictionBridge(supportingRows);
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(runRequest(repositoryPath), stateDirectory);
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(capture.invocations).toHaveLength(1);
      expect(capture.invocations[0]).not.toHaveProperty("firstPassNotices");
    });

    it("reaches workflow execution past an evidence gap and hands the run its limitation lines (#2113)", async () => {
      // A missing obligation with no disagreement beside it is a limitation of
      // first pass, not a stop: the run goes on with the evidence gathered.
      bridgeHolder.bridge = contradictionBridge(
        (seeds, frames) =>
          supportingRows(seeds, frames).map((row) =>
            row.obligationId === "decomposed-health-probe"
              ? {
                  obligationId: "decomposed-health-probe",
                  status: "missing",
                  evidenceSpanIds: [],
                  detail: "No health probe source was offered.",
                }
              : row,
          ),
        [
          {
            id: "decomposed-health-probe",
            origin: "inferred",
            instructionQuote: null,
            targetPaths: [TARGET],
            condition: "An example health probe for the service is documented.",
            requiredSourceSupport: true,
          },
        ],
      );
      const { repositoryPath, stateDirectory } = await repository();
      const outcome = await run(runRequest(repositoryPath), stateDirectory);
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(capture.invocations).toHaveLength(1);
      const lines = (capture.invocations[0] as { firstPassNotices?: readonly string[] })
        .firstPassNotices;
      expect(lines).toEqual([
        "first-pass-evidence-gaps: first pass continued after 1 assessment round with 1 mandatory obligation its repository evidence did not support. It ended no-progress: an attempt to read further found no new evidence, so reading further was not expected to close an open obligation. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.",
        "first-pass-evidence-gaps: obligation decomposed-health-probe is missing.",
      ]);
      // The preflight status writes the same lines to the coordinator's stderr sink.
      for (const line of lines!) expect(outcome.errors.join("\n")).toContain(line);
      expect(await savedRunIds(stateDirectory)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // validateFirstPassSupport over a real support record.

  interface SupportFixture {
    terminationReason: string;
    exhaustedBounds?: Row[];
    limits: Record<string, number>;
    snapshotSha256: string;
    assessmentIdentitySha256: string;
    supportSha256: string;
    obligations: Row[];
    [key: string]: unknown;
  }

  function rehash(support: SupportFixture): SupportFixture {
    const { supportSha256: _supportSha256, ...body } = support;
    support.supportSha256 = sha(canonical(body));
    return support;
  }

  const OBLIGATION_BASE_KEYS = [
    "id",
    "origin",
    "instructionSpan",
    "targetPaths",
    "condition",
    "requiredSourceSupport",
  ];

  /**
   * The binding the shipped bridge computes for a model answer that wrote these
   * obligations and rows: the recorded prompt with its obligation line and
   * answer rebuilt from the support record.
   */
  function bridgeBinding(prompt: string, support: SupportFixture): string {
    const base = support.obligations.map((item) =>
      Object.fromEntries(
        OBLIGATION_BASE_KEYS.filter((key) => key in item).map((key) => [key, item[key]]),
      ),
    );
    const rows = support.obligations.map((item) => {
      const {
        id,
        origin: _o,
        instructionSpan: _i,
        targetPaths: _t,
        condition: _c,
        requiredSourceSupport: _r,
        ...rest
      } = item;
      return { obligationId: id, ...rest };
    });
    const rebuilt = prompt
      .split("\n")
      .map((line) =>
        line.startsWith("Mandatory obligations: ")
          ? `Mandatory obligations: ${JSON.stringify(base)}`
          : line,
      )
      .join("\n");
    return firstPassAssessmentBindingSha256(
      rebuilt,
      JSON.stringify({ schemaVersion: 1, assessments: rows }),
      parseEvidenceFrames,
    );
  }

  async function helperWorkspace(files: Readonly<Record<string, string>> = PORT_FILES) {
    const root = await roots.create("docsfab-contradiction-helper-");
    const workspace = join(root, "workspace");
    const stateDirectory = join(root, "state");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), text);
    }
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    return { root, workspace, stateDirectory };
  }

  async function bindHelper(
    setup: Awaited<ReturnType<typeof helperWorkspace>>,
    bridge: ReturnType<typeof contradictionBridge>,
    requestOverride: Partial<RunRequestWithPublishProjection> = {},
  ) {
    return bindFirstPassKnowledge({
      request: {
        workflow: "update-documentation",
        repositoryPath: setup.workspace,
        revision: "HEAD",
        instruction: HELPER_INSTRUCTION,
        ...requestOverride,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      config: {
        projectRoot: runtimeRoot,
        skillCrateDirectory: join(runtimeRoot, "skill-crate"),
        qualityDirectory: join(runtimeRoot, "..", "quality"),
        qualityPackDirectory: join(runtimeRoot, "quality-pack"),
        stateDirectory: setup.stateDirectory,
        retryPolicy: {
          maxRetries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: [],
        },
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      workspacePath: setup.workspace,
      revision: REVISION,
      status: () => undefined,
      supportModelBridge: bridge,
    }).catch((error: unknown) => error);
  }

  async function recordedSupport(setup: Awaited<ReturnType<typeof helperWorkspace>>) {
    return JSON.parse(
      await readFile(
        join(setup.root, "knowledge", "first-pass", REVISION, "docsfab-first-pass-support.json"),
        "utf8",
      ),
    ) as SupportFixture;
  }

  describe("validateFirstPassSupport decides the contradicted stop from verified sides", () => {
    async function contradicted(sides: SidesSpec = PORT_SIDES, files = PORT_FILES) {
      const setup = await helperWorkspace(files);
      const bridge = contradictionBridge(contradictedRows(sides));
      const stop = await bindHelper(setup, bridge);
      const support = await recordedSupport(setup);
      const input = (
        overrides: Partial<Parameters<typeof validateFirstPassSupport>[0]> = {},
      ): Parameters<typeof validateFirstPassSupport>[0] => ({
        support,
        workspacePath: setup.workspace,
        workflow: "update-documentation",
        instruction: HELPER_INSTRUCTION,
        instructionTargetPaths: [TARGET],
        revision: REVISION,
        snapshotSha256: support.snapshotSha256,
        expectedAssessmentIdentitySha256: support.assessmentIdentitySha256,
        expectedAssessmentBindingSha256: bridge.lastAssessmentBindingSha256(),
        ...overrides,
      });
      return { setup, bridge, stop, support, input };
    }

    /** A clone with every contradicted obligation edited, its digest and bridge binding rebuilt. */
    function tampered(
      fixture: Awaited<ReturnType<typeof contradicted>>,
      edit: (item: Row) => void,
      rebind = true,
    ) {
      const support = structuredClone(fixture.support);
      for (const item of support.obligations) if (item.status === "contradicted") edit(item);
      rehash(support);
      return fixture.input({
        support,
        ...(rebind
          ? {
              expectedAssessmentBindingSha256: bridgeBinding(
                fixture.bridge.prompts.at(-1)!,
                support,
              ),
            }
          : {}),
      });
    }

    it("throws contradicted with the verified sides, and the support record still verifies", async () => {
      const fixture = await contradicted();
      expect(fixture.stop).toBeInstanceOf(FirstPassSupportValidationError);
      expect(fixture.stop).toMatchObject({ code: "contradicted" });
      const contradictions = (fixture.stop as FirstPassSupportValidationError).contradictions!;
      expect(contradictions.length).toBeGreaterThan(0);
      expect(contradictions[0]!.sides).toEqual([
        expect.objectContaining({ path: "deploy.yaml", value: "9090" }),
        expect.objectContaining({ path: "src/server.ts", value: "8088" }),
      ]);
      // The page has no supported obligation: its support gap goes with the contradiction (P2).
      expect(
        fixture.support.obligations.some(
          (item) => item.status === "supported" && item.requiredSourceSupport,
        ),
      ).toBe(false);
      // The bridge-side binding rebuilt from the record equals the shipped one.
      expect(bridgeBinding(fixture.bridge.prompts.at(-1)!, fixture.support)).toBe(
        fixture.bridge.lastAssessmentBindingSha256(),
      );
      await expect(validateFirstPassSupport(fixture.input())).rejects.toMatchObject({
        code: "contradicted",
      });
    });

    it("refuses sides in a shape the assessment cannot write as invalid-support (row 8)", async () => {
      const fixture = await contradicted();
      const spans = fixture.support.sourceSpans as { id: string; path: string }[];
      const target = spans.find((span) => span.path === TARGET)!;
      const cases: [string, (item: Row) => void][] = [
        ["an unknown span id", (item) => ((item.sides as Row[])[1]!.spanId = "SPAN-999")],
        // V2: a real span, but not one this obligation cites.
        [
          "a span outside the obligation's evidence",
          (item) => ((item.sides as Row[])[1]!.spanId = target.id),
        ],
        ["one side", (item) => (item.sides = (item.sides as Row[]).slice(0, 1))],
        ["one distinct value", (item) => ((item.sides as Row[])[1]!.value = "9090")],
        [
          "values equal once normalized (NFC and NFD)",
          (item) => {
            (item.sides as Row[])[0]!.value = "caf\u00e9";
            (item.sides as Row[])[1]!.value = "cafe\u0301";
          },
        ],
        [
          "values equal once line endings are normalized",
          (item) => {
            (item.sides as Row[])[0]!.value = "port:\r\n9090";
            (item.sides as Row[])[1]!.value = "port:\n9090";
          },
        ],
        [
          "a value over firstPass.maxContradictionValueChars",
          (item) =>
            ((item.sides as Row[])[1]!.value = "8".repeat(
              limit("firstPass.maxContradictionValueChars").value + 1,
            )),
        ],
        [
          "more sides than firstPass.maxContradictionSides",
          (item) =>
            (item.sides = Array.from(
              { length: limit("firstPass.maxContradictionSides").value + 1 },
              (_, index) => ({
                ...(item.sides as Row[])[index % 2]!,
                value: String(index),
              }),
            )),
        ],
        ["an unknown side key", (item) => ((item.sides as Row[])[1]!.pathClass = "source")],
        ["an empty value", (item) => ((item.sides as Row[])[1]!.value = " ")],
        ["sides on a supported obligation", (item) => (item.status = "supported")],
      ];
      // Every case runs, so a mutant shows each shape it lets through.
      const admitted: string[] = [];
      for (const [name, edit] of cases) {
        const outcome = await validateFirstPassSupport(tampered(fixture, edit)).catch(
          (error: unknown) => error,
        );
        if (
          !(
            outcome instanceof FirstPassSupportValidationError && outcome.code === "invalid-support"
          )
        ) {
          admitted.push(`${name}: ${outcome instanceof Error ? outcome.message : "admitted"}`);
        }
      }
      expect(admitted).toEqual([]);
    });

    it("admits exactly firstPass.maxContradictionSides sides and a value of exactly firstPass.maxContradictionValueChars characters (row 8)", async () => {
      const maxSides = limit("firstPass.maxContradictionSides").value;
      const maxChars = limit("firstPass.maxContradictionValueChars").value;
      // A value at the bound that its span holds verbatim reaches the question.
      const long = "a".repeat(maxChars);
      const atChars = await contradicted(
        (frames) => [
          { spanId: frameWith(frames, "deploy.yaml", "9090").id, value: long },
          {
            spanId: frameWith(frames, "src/server.ts", "8088").id,
            value: "8088",
          },
        ],
        {
          ...PORT_FILES,
          "deploy.yaml": `service:\n  port: 9090\n  image: ${long}\n`,
        },
      );
      expect(atChars.stop).toMatchObject({ code: "contradicted" });
      for (const contradiction of (atChars.stop as FirstPassSupportValidationError)
        .contradictions!) {
        expect(contradiction.sides.map((side) => side.value)).toEqual([long, "8088"]);
      }
      await expect(validateFirstPassSupport(atChars.input())).rejects.toMatchObject({
        code: "contradicted",
      });
      // Sides at the bound, with the shape the over-bound row uses.
      const fixture = await contradicted();
      const atSides = await validateFirstPassSupport(
        tampered(fixture, (item) => {
          item.sides = Array.from({ length: maxSides }, (_, index) => ({
            ...(item.sides as Row[])[index % 2]!,
            value: String(index),
          }));
        }),
      ).catch((error: unknown) => error as FirstPassSupportValidationError);
      expect(atSides).toMatchObject({ code: "contradicted" });
      expect(atSides.contradictions![0]!.sides).toHaveLength(2);
    });

    it("refuses sides edited after the model answered as support-binding-mismatch (row 8)", async () => {
      const fixture = await contradicted();
      await expect(
        validateFirstPassSupport(
          tampered(fixture, (item) => ((item.sides as Row[])[0]!.value = "9091"), false),
        ),
      ).rejects.toMatchObject({ code: "support-binding-mismatch" });
      // Removing the sides after the answer is the same tamper.
      await expect(
        validateFirstPassSupport(tampered(fixture, (item) => delete item.sides, false)),
      ).rejects.toMatchObject({ code: "support-binding-mismatch" });
    });

    it("keeps budget-exhausted for a bound stop, and insufficient-evidence for a round without new evidence (row 7)", async () => {
      const fixture = await contradicted();
      const bounded = structuredClone(fixture.support);
      bounded.terminationReason = "budget-exhausted";
      bounded.exhaustedBounds = [
        {
          bound: "maxSourceFiles",
          observed: bounded.limits.maxSourceFiles! + 1,
          limit: bounded.limits.maxSourceFiles!,
        },
      ];
      rehash(bounded);
      await expect(
        validateFirstPassSupport(fixture.input({ support: bounded })),
      ).rejects.toMatchObject({
        code: "budget-exhausted",
      });
      const stalled = structuredClone(fixture.support);
      stalled.terminationReason = "no-progress";
      rehash(stalled);
      await expect(
        validateFirstPassSupport(fixture.input({ support: stalled })),
      ).rejects.toMatchObject({
        code: "insufficient-evidence",
      });
    });

    it("keeps insufficient-evidence, with the gap and the bounds leading, when first pass left a named source or bound evidence unread (row 7)", async () => {
      const fixture = await contradicted();
      // Positive control: the same record with neither stops contradicted.
      await expect(validateFirstPassSupport(fixture.input())).rejects.toMatchObject({
        code: "contradicted",
      });
      // A named source first pass could not read.
      const named = structuredClone(fixture.support);
      named.namedSourceGaps = [{ path: "config/ports.md", reason: "missing" }];
      rehash(named);
      const gap = await validateFirstPassSupport(fixture.input({ support: named })).catch(
        (error: unknown) => error as FirstPassSupportValidationError,
      );
      expect(gap).toMatchObject({
        code: "insufficient-evidence",
        contradictions: undefined,
      });
      expect(gap.message).toMatch(
        /^The request names sources first pass could not read: config\/ports\.md /u,
      );
      expect(gap.nextAction).toMatch(/^Check each source the request names/u);
      // A bound reached that did not stop acquisition, with files left unread.
      const reached = structuredClone(fixture.support);
      reached.exhaustedBounds = [
        {
          bound: "maxSourceFiles",
          observed: reached.limits.maxSourceFiles! + 1,
          limit: reached.limits.maxSourceFiles!,
        },
      ];
      reached.unreadFiles = { count: 1, namedPaths: [] };
      rehash(reached);
      expect(reached.terminationReason).toBe("unresolved-obligations");
      const bound = await validateFirstPassSupport(fixture.input({ support: reached })).catch(
        (error: unknown) => error as FirstPassSupportValidationError,
      );
      expect(bound).toMatchObject({
        code: "insufficient-evidence",
        contradictions: undefined,
      });
      expect(bound.message).toContain(
        "First pass also reached these bounds, which may have left evidence unread:",
      );
      expect(bound.message).toContain("Reading stopped with 1 candidate source file unread.");
      expect(bound.nextAction).toMatch(/^To read past its bounds, raise /u);
      expect(bound.details.map((item) => item.status)).toContain("contradicted");
    });

    it("keeps insufficient-evidence for a page whose only contradiction spans several pages (row 7)", async () => {
      const fixture = await contradicted();
      const spanId = (fixture.support.sourceSpans as { id: string }[])[0]!.id;
      const pages = [TARGET, OPERATIONS];
      /** The record over two pages: the operations page supported, the contradictions edited. */
      const twoPages = (edit: (obligations: Row[]) => void) => {
        const support = structuredClone(fixture.support);
        support.targetPaths = pages;
        support.obligations.push({
          id: "operations-support",
          origin: "inferred",
          targetPaths: [OPERATIONS],
          condition: "The restart step for the operations page is documented.",
          requiredSourceSupport: true,
          status: "supported",
          evidenceSpanIds: [spanId],
          detail: "Supported by the offered span.",
        });
        edit(support.obligations);
        rehash(support);
        return fixture.input({
          support,
          instructionTargetPaths: pages,
          expectedAssessmentBindingSha256: bridgeBinding(fixture.bridge.prompts.at(-1)!, support),
        });
      };
      const contradictedOf = (obligations: Row[]) =>
        obligations.filter((item) => item.status === "contradicted");
      // Answering a two-page contradiction still leaves the deployment page unsupported.
      await expect(
        validateFirstPassSupport(
          twoPages((obligations) => {
            for (const item of contradictedOf(obligations)) item.targetPaths = pages;
          }),
        ),
      ).rejects.toMatchObject({ code: "insufficient-evidence" });
      // Positive control: a single-page contradiction of its own beside it is the page's support.
      await expect(
        validateFirstPassSupport(
          twoPages((obligations) => {
            const own = contradictedOf(obligations).map((item) => ({
              ...structuredClone(item),
              id: `${String(item.id)}-own`,
            }));
            for (const item of contradictedOf(obligations)) item.targetPaths = pages;
            obligations.push(...own);
          }),
        ),
      ).rejects.toMatchObject({ code: "contradicted" });
    });

    it("keeps insufficient-evidence for a page whose contradiction an answer would not support (row 7)", async () => {
      const fixture = await contradicted();
      // Not required: answering it would leave the page without support.
      await expect(
        validateFirstPassSupport(tampered(fixture, (item) => (item.requiredSourceSupport = false))),
      ).rejects.toMatchObject({ code: "insufficient-evidence" });
    });

    it("admits values a reader would quote: backticked text, multi-line, CRLF, a whole line", async () => {
      const probes: [string, Record<string, string>, SidesSpec, string[]][] = [
        [
          "backticked doc value",
          {
            [TARGET]: "# Deployment\n\nThe health check returns `202 Accepted`.\n",
            "src/server.ts": "// Health.\nres.status(200);\n",
            "deploy.yaml": "port: 9090\n",
          },
          (frames) => [
            {
              spanId: frameWith(frames, TARGET, "202").id,
              value: "202 Accepted",
            },
            {
              spanId: frameWith(frames, "src/server.ts", "200").id,
              value: "200",
            },
          ],
          ["202 Accepted", "200"],
        ],
        [
          "multi-line value",
          PORT_FILES,
          (frames) => [
            {
              spanId: frameWith(frames, "deploy.yaml", "9090").id,
              value: "replicas: 2\n  port: 9090",
            },
            {
              spanId: frameWith(frames, "src/server.ts", "8088").id,
              value: "8088",
            },
          ],
          ["replicas: 2\n  port: 9090", "8088"],
        ],
        [
          "CRLF file",
          {
            ...PORT_FILES,
            "deploy.yaml": "service:\r\n  name: api\r\n  replicas: 2\r\n  port: 9090\r\n",
          },
          (frames) => [
            {
              spanId: frameWith(frames, "deploy.yaml", "9090").id,
              value: "replicas: 2\r\n  port: 9090",
            },
            {
              spanId: frameWith(frames, "src/server.ts", "8088").id,
              value: "8088",
            },
          ],
          ["replicas: 2\n  port: 9090", "8088"],
        ],
        [
          "whole line",
          PORT_FILES,
          (frames) => [
            {
              spanId: frameWith(frames, "deploy.yaml", "9090").id,
              value: "  port: 9090",
            },
            {
              spanId: frameWith(frames, "src/server.ts", "8088").id,
              value: inputs.portDeclaration,
            },
          ],
          ["  port: 9090", inputs.portDeclaration],
        ],
      ];
      for (const [name, files, sides, values] of probes) {
        const cite = (frames: readonly Frame[]) =>
          (sides(frames) ?? []).map((side) => side.spanId as string);
        const setup = await helperWorkspace(files);
        const stop = await bindHelper(setup, contradictionBridge(contradictedRows(sides, cite)));
        if (name === "backticked doc value") {
          expect(stop).toMatchObject({ completed: true });
          const lines = (
            stop as { firstPassEvidenceWarnings: readonly string[] }
          ).firstPassEvidenceWarnings.join("\n");
          for (const value of values) expect(lines).toContain(value);
          expect(
            (await recordedSupport(setup)).obligations.some((row) => row.status === "contradicted"),
          ).toBe(true);
          continue;
        }
        expect(stop, name).toBeInstanceOf(FirstPassSupportValidationError);
        expect((stop as FirstPassSupportValidationError).code, name).toBe("contradicted");
        for (const contradiction of (stop as FirstPassSupportValidationError).contradictions!) {
          expect(
            contradiction.sides.map((side) => side.value),
            name,
          ).toEqual(values);
        }
      }
    });
    it("shows control characters and line breaks in a verified value as escapes, and records the value as found", async () => {
      const clear = "\u001b[2J9090";
      const fixture = await contradicted(
        (frames) => [
          { spanId: frameWith(frames, "deploy.yaml", "9090").id, value: clear },
          {
            spanId: frameWith(frames, "src/server.ts", "8088").id,
            value: inputs.portSource,
          },
        ],
        { ...PORT_FILES, "deploy.yaml": `service:\n  port: ${clear}\n` },
      );
      expect(fixture.stop).toMatchObject({ code: "contradicted" });
      const record = firstPassContradictionRecord(
        (fixture.stop as FirstPassSupportValidationError).contradictions!,
      );
      expect(record.contradictions[0]!.sides[0]!.value).toBe(clear);
      expect(decodeRunRecordFirstPassContradiction(structuredClone(record))).toEqual(record);
      const shown = formatFirstPassContradictionLines({
        firstPassContradiction: record,
      });
      const raw = /[\u0000-\u001f\u007f-\u009f]/u;
      expect(shown.filter((line) => raw.test(line))).toEqual([]);
      expect(
        shown.filter(
          (line) => line.startsWith("Side: deploy.yaml line") && line.endsWith('"\\u{1b}[2J9090"'),
        ),
      ).toHaveLength(1);
      expect(record.question.question).toContain('has "\\u{1b}[2J9090"');
      // The obligation condition is model text, written the same way.
      const condition = firstPassContradictionRecord([
        { ...record.contradictions[0]!, condition: `The port is ${clear}.` },
      ]).question.question;
      expect(condition).toContain('For "The port is \\u{1b}[2J9090."');
      expect(raw.test(condition)).toBe(false);
      expect(record.question.question).toContain(
        `has ${JSON.stringify(inputs.portSource).replaceAll("\\n", "\\u{a}")}`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // The recorded field and its NEXT.

  describe("the recorded question field", () => {
    const contradictions = [
      {
        obligationId: "target-01",
        targetPaths: [TARGET],
        condition: "Document the listening port.",
        sides: [
          { path: "deploy.yaml", lineStart: 1, lineEnd: 4, value: "9090" },
          { path: "src/server.ts", lineStart: 2, lineEnd: 2, value: "8088" },
        ],
      },
    ];

    it("refuses a hand-edited question and shows NEXT to inspect instead", async () => {
      const { firstPassContradictionRecord } = await import(
        "../src/cli/run/first-pass-contradiction-stop.js"
      );
      const field = firstPassContradictionRecord(contradictions);
      expect(decodeRunRecordFirstPassContradiction(structuredClone(field))).toEqual(field);
      const edited = structuredClone(field) as {
        question: { recommendedDefault: string };
      };
      edited.question.recommendedDefault = "Use 9090";
      expect(() => decodeRunRecordFirstPassContradiction(edited)).toThrow(
        RunRecordFirstPassContradictionError,
      );
      // Every question field is checked on its own, so each edit alone is refused.
      type Question = { question: string; options: string[]; consequence: string };
      const edits: [string, (question: Question) => void][] = [
        ["question", (question) => (question.question = `${question.question} Use 9090.`)],
        ["consequence", (question) => (question.consequence = "DocsFab writes 9090.")],
        ["an option", (question) => (question.options[0] = "Use 9090")],
        ["an extra option", (question) => question.options.push("Use 9090")],
        ["a dropped option", (question) => question.options.pop()],
      ];
      const admitted = edits
        .filter(([, edit]) => {
          const copy = structuredClone(field) as unknown as { question: Question };
          edit(copy.question);
          try {
            decodeRunRecordFirstPassContradiction(copy);
            return true;
          } catch (error) {
            if (!(error instanceof RunRecordFirstPassContradictionError)) throw error;
            return false;
          }
        })
        .map(([name]) => name);
      expect(admitted).toEqual([]);
      const record = {
        schemaVersion: 2,
        id: "run-edited",
        workflow: "update-documentation",
        repository: {
          sourcePath: "/repo",
          requestedRevision: "HEAD",
          revision: REVISION,
        },
        workspace: { strategy: "tracked-export", disposable: true },
        status: "needs-input",
        error: "contradicted",
        createdAt: "2026-10-06T00:00:00.000Z",
        models: [],
        skills: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          turns: 0,
        },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        firstPassContradiction: edited,
        steps: [],
      } as unknown as RunRecord;
      const next = collectRunResultNextSteps({
        record,
        recordPath: "/state/run-edited.json",
        exitCode: 2,
        repositoryPath: "/repo",
      });
      expect(next.join("\n")).toContain(
        "The recorded first-pass question does not have the shape DocsFab writes",
      );
      expect(next.join("\n")).not.toContain("Use 9090");
      const shaped = collectRunResultNextSteps({
        record: { ...record, firstPassContradiction: field },
        recordPath: "/state/run-edited.json",
        exitCode: 2,
        repositoryPath: "/repo",
      });
      expect(shaped.join("\n")).toContain(`Question: ${field.question.question}`);
    });

    it("leaves a needs-input record without the field to the other branches", () => {
      // Adjacent condition: a needs-input run with no first-pass contradiction.
      const record = {
        schemaVersion: 2,
        id: "run-other",
        workflow: "update-documentation",
        repository: {
          sourcePath: "/repo",
          requestedRevision: "HEAD",
          revision: REVISION,
        },
        workspace: { strategy: "tracked-export", disposable: true },
        status: "needs-input",
        createdAt: "2026-10-06T00:00:00.000Z",
        models: [],
        skills: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          turns: 0,
        },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        steps: [],
      } as unknown as RunRecord;
      const next = collectRunResultNextSteps({
        record,
        recordPath: "/state/run-other.json",
        exitCode: 2,
        repositoryPath: "/repo",
      });
      expect(next.join("\n")).not.toContain("First pass found repository sources that disagree");
    });
  });

  describe("admitted first-pass authority preferences", () => {
    it.each([
      ["ordinary comment", "// Additional handler context lives here.", true],
      ["ordinary comment with final newline", "// Additional handler context lives here.\n", true],
      [
        "ordinary block with outer whitespace",
        "\n/* Additional handler context lives here. */\n\n",
        true,
      ],
      [
        "mixed comment and code",
        "// Additional handler context lives here.\nexport const retryStatus = 500;\n",
        false,
      ],
      ["unrelated implementation", "export const retryStatus = 500;\n", false],
      ["legal metadata", "// All rights are reserved.\n", false],
      ["compiler metadata", "/* node:coverage ignore next */\n", false],
      [
        "runtime string",
        'export const detail = "// Additional handler context lives here.";\n',
        false,
      ],
    ] as const)(
      "classifies the entire non-valued supporting excerpt from %s",
      async (_name, source, accepted) => {
        const setup = await helperWorkspace({
          [TARGET]: "# Deployment\n",
          "docs/api.md": "Health returns 202 Accepted.\n",
          "src/health.ts": "export const healthStatus = 200;\n",
          "src/support.ts": source,
        });
        const bridge = contradictionBridge((seeds, frames) => {
          const docs = frameWith(frames, "docs/api.md", "202");
          const code = frameWith(frames, "src/health.ts", "200");
          const support = frameWith(frames, "src/support.ts", "");
          return seeds.map((seed) => ({
            obligationId: seed.id,
            status: seed.requiredSourceSupport ? "contradicted" : "supported",
            evidenceSpanIds: seed.requiredSourceSupport ? [docs.id, code.id, support.id] : [],
            ...(seed.requiredSourceSupport
              ? {
                  sides: [
                    { spanId: docs.id, value: "202" },
                    { spanId: code.id, value: "200" },
                  ],
                }
              : {}),
            detail: "Health status differs; the additional excerpt asserts no disputed value.",
          }));
        });
        const result = await bindHelper(setup, bridge, {
          instruction: "Update docs/deployment.md with the health response status.",
        });
        if (accepted) {
          expect(result).toMatchObject({ completed: true });
          const warnings = (
            result as { firstPassEvidenceWarnings: readonly string[] }
          ).firstPassEvidenceWarnings.join("\n");
          expect(warnings).toContain("docs-stale:");
          expect(warnings).toContain("supporting citation (documentation)");
          expect(warnings).toContain("src/support.ts");
          expect(warnings).not.toContain("supporting citation (implementation)");
        } else expect(result).toMatchObject({ code: "contradicted" });
        expect(await readFile(join(setup.workspace, "src/support.ts"), "utf8")).toBe(source);
        expect(await readFile(join(setup.workspace, "src/health.ts"), "utf8")).toBe(
          "export const healthStatus = 200;\n",
        );
      },
    );

    it.each(
      [true, false].flatMap((configured) =>
        (
          [
            "three-sided",
            "documentation-only",
            "documentation-only JSON key",
            "recorded setup",
            "recorded JSON examples",
          ] as const
        ).map((citation) => [configured, citation] as const),
      ),
    )(
      `settles ${inputs.exampleName} with project config %s and %s assessment without changing the CREATE request`,
      async (withProjectConfig, citation) => {
        const files = [
          "README.md",
          "docs/guide.md",
          "docs/quickstart.md",
          `${inputs.cliSourcePath}`,
        ];
        const fixtureRoot = resolve(inputs.fixtureRoot, inputs.repositoryDirectory);
        const setup = await repository(
          Object.fromEntries(
            await Promise.all(
              files.map(async (path) => [
                path,
                await readFile(
                  join(fixtureRoot, path === `${inputs.cliSourcePath}` ? `${path}.fixture` : path),
                  "utf8",
                ),
              ]),
            ),
          ),
          withProjectConfig,
          {},
          await readFile(join(fixtureRoot, "../project-config.json.fixture"), "utf8"),
        );
        const retainedSupport =
          citation === "recorded setup" || citation === "recorded JSON examples"
            ? (JSON.parse(
                await readFile(
                  join(
                    fixtureRoot,
                    citation === "recorded setup"
                      ? "../setup-support.json.fixture"
                      : "../harness-support.json.fixture",
                  ),
                  "utf8",
                ),
              ) as {
                sourceSpans: { id: string; path: string }[];
                obligations: {
                  status: string;
                  evidenceSpanIds: string[];
                  sides?: { spanId: string; value: string }[];
                }[];
              })
            : undefined;
        bridgeHolder.bridge = contradictionBridge((seeds, frames) => {
          if (retainedSupport) {
            const row = retainedSupport.obligations.find((item) => item.status === "contradicted")!;
            const path = (id: string) =>
              retainedSupport.sourceSpans.find((span) => span.id === id)!.path;
            const sides = row.sides!.map((side) => ({
              spanId: frameWith(frames, path(side.spanId), side.value).id,
              value: side.value,
            }));
            const cited = row.evidenceSpanIds.map((id) => frameWith(frames, path(id), "").id);
            return seeds.map((seed) => ({
              obligationId: seed.id,
              status: seed.requiredSourceSupport ? "contradicted" : "supported",
              evidenceSpanIds: seed.requiredSourceSupport ? cited : [],
              detail: "The retained QA values and all supporting citations are preserved.",
              ...(seed.requiredSourceSupport ? { sides } : {}),
            }));
          }
          const jsonKey = citation === "documentation-only JSON key";
          const guideValue = jsonKey ? "message" : `${inputs.currentName}`;
          const quickstartValue = jsonKey ? "greeting" : `${inputs.oldName}`;
          const guide = frameWith(frames, "docs/guide.md", guideValue);
          const quickstart = frameWith(frames, "docs/quickstart.md", quickstartValue);
          const implementation =
            citation === "three-sided"
              ? frameWith(frames, `${inputs.cliSourcePath}`, guideValue)
              : undefined;
          const sides = [
            { spanId: guide.id, value: guideValue },
            { spanId: quickstart.id, value: quickstartValue },
            ...(citation === "three-sided"
              ? [{ spanId: implementation!.id, value: guideValue }]
              : []),
          ];
          return seeds.map((seed) => ({
            obligationId: seed.id,
            status: seed.requiredSourceSupport ? "contradicted" : "supported",
            evidenceSpanIds: seed.requiredSourceSupport ? sides.map((side) => side.spanId) : [],
            detail: "The implementation and guide agree; quickstart is stale.",
            ...(seed.requiredSourceSupport ? { sides } : {}),
          }));
        });
        const instruction = "Create docs/a.md, a setup guide for developers.";
        const outcome = await run(
          runRequest(setup.repositoryPath, false, "create-documentation", instruction),
          setup.stateDirectory,
          {
            async call() {
              return {
                text: JSON.stringify({
                  operation: "create",
                  targets: [
                    {
                      path: "docs/a.md",
                      role: "write",
                      chosenFrom: "named",
                      quote: "docs/a.md",
                    },
                  ],
                  authorityPreference: { preference: "unspecified", quote: null },
                }),
                usage: { inputTokens: 3, outputTokens: 2 },
              };
            },
          },
        );
        expect((outcome.error as Error)?.message).toBe(STOP_AT_EXECUTION);
        expect(capture.invocations).toHaveLength(1);
        const warnings = (
          capture.invocations[0] as { firstPassNotices?: readonly string[] }
        ).firstPassNotices?.join("\n");
        expect(warnings).toContain("docs-stale:");
        expect(warnings).toContain("docs/guide.md");
        expect(warnings).toContain("docs/quickstart.md");
        expect(warnings).toContain(`${inputs.cliSourcePath}`);
        expect(await savedRunIds(setup.stateDirectory)).toEqual([]);
      },
      JOURNEY_MS,
    );

    it.each([
      {
        name: "an explicit export without a shared source link",
        code: "export const status = 200;\n",
        accepted: false,
        explicitExport: true,
        linked: false,
      },
      {
        name: "an explicitly documented export",
        code: "export const status = 200;\n",
        accepted: true,
        explicitExport: true,
      },
      {
        name: "an incidental literal beside another status",
        code: "const retryDelay = 200; export const status = 500;\n",
        accepted: false,
      },
      {
        name: "an incidental literal beside an explicit export",
        code: "const retryDelay = 200; export const status = 500;\n",
        accepted: false,
        explicitExport: true,
      },
      { name: "an unbound runtime literal", code: "export const status = 200;\n", accepted: false },
      {
        name: "an unbound literal beside a comment",
        code: "// Old status 202.\nexport const status = 200;\n",
        accepted: false,
      },
      {
        name: "only a comment",
        code: "// Status 200.\nexport const status = 404;\n",
        accepted: false,
      },
      {
        name: "only an erased type",
        code: "export type Status = 200;\nexport const status = 404;\n",
        accepted: false,
      },
      {
        name: "two executable values",
        code: "export const active = 200;\nexport const staged = 202;\n",
        accepted: false,
      },
      {
        name: "an unrelated implementation",
        code: "export const status = 200;\n",
        accepted: false,
        linked: false,
      },
      {
        name: "a malformed implementation",
        code: "export const status = ; // 200\n",
        accepted: false,
      },
      {
        name: "a variable name instead of its value",
        code: `export const ${inputs.currentName} = 'developer';\n`,
        accepted: false,
        values: [`${inputs.oldName}`, `${inputs.currentName}`],
      },
      {
        name: "an unbound object key",
        code: "export const greeting = { message: 'hello' };\n",
        accepted: false,
        values: ["greeting", "message"],
      },
    ])(
      "corroborates docs-only evidence from $name without granting unrelated authority",
      async ({
        code,
        accepted,
        linked = true,
        values = ["202", "200"],
        explicitExport = false,
      }) => {
        const shared = "[Implementation](../src/health.ts)";
        const setup = await helperWorkspace({
          [TARGET]: "# Deployment\n",
          "docs/api.md": `${explicitExport ? `The \`status\` export is \`${values[0]}\`.` : `Status ${values[0]}.`} ${shared}\n`,
          "docs/quickstart.md": `${explicitExport ? `The \`status\` export is \`${values[1]}\`.` : `Status ${values[1]}.`} ${linked ? shared : "No implementation link."}\n`,
          "src/health.ts": code,
        });
        const bridge = contradictionBridge((seeds, frames) =>
          seeds.map((seed) => {
            const sides = [
              { spanId: frameWith(frames, "docs/api.md", values[0]!).id, value: values[0] },
              { spanId: frameWith(frames, "docs/quickstart.md", values[1]!).id, value: values[1] },
            ];
            return {
              obligationId: seed.id,
              status: seed.requiredSourceSupport ? "contradicted" : "supported",
              evidenceSpanIds: seed.requiredSourceSupport ? sides.map((side) => side.spanId) : [],
              ...(seed.requiredSourceSupport ? { sides } : {}),
              detail: "The documentation pages disagree about the health status.",
            };
          }),
        );
        const result = await bindHelper(setup, bridge);
        if (accepted) {
          expect(result).toMatchObject({ completed: true });
          expect(
            (result as { firstPassEvidenceWarnings: string[] }).firstPassEvidenceWarnings.join(
              "\n",
            ),
          ).toContain(`chosen value: ${JSON.stringify(values[1])}`);
        } else expect(result).toMatchObject({ code: "contradicted" });
      },
    );

    it("carries a settled docs discrepancy through the shipped request entry into execution notices", async () => {
      const setup = await repository({
        "docs/api.md": "Health returns 202 Accepted.\n",
        "src/health.ts": "export const healthStatus = 200;\n",
      });
      bridgeHolder.bridge = contradictionBridge((seeds, frames) => {
        const docs = frameWith(frames, "docs/api.md", "202");
        const code = frameWith(frames, "src/health.ts", "200");
        return seeds.map((seed) => ({
          obligationId: seed.id,
          status: seed.requiredSourceSupport ? "contradicted" : "supported",
          evidenceSpanIds: seed.requiredSourceSupport ? [docs.id, code.id] : [],
          detail: "Health status discrepancy.",
          ...(seed.requiredSourceSupport
            ? {
                sides: [
                  { spanId: docs.id, value: "202" },
                  { spanId: code.id, value: "200" },
                ],
              }
            : {}),
        }));
      });
      const request = runRequest(
        setup.repositoryPath,
        false,
        "update-documentation",
        "Update the deployment guide and the operations guide with the health status. Match current implementation.",
      );
      const interpreter = admitPages("update-documentation");
      const outcome = await run(request, setup.stateDirectory, {
        call: async (input) => {
          const response = await interpreter.call(input);
          return {
            ...response,
            text: JSON.stringify({
              ...JSON.parse(response.text),
              authorityPreference: {
                preference: "implementation",
                quote: "Match current implementation",
              },
            }),
          };
        },
      });
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(capture.invocations).toHaveLength(1);
      const lines = (
        capture.invocations[0] as { firstPassNotices: readonly string[] }
      ).firstPassNotices.join("\n");
      for (const expected of ["docs-stale:", "202", "200", "docs/api.md", "src/health.ts"])
        expect(lines).toContain(expected);
      expect(await readFile(join(setup.repositoryPath, "docs/api.md"), "utf8")).toBe(
        "Health returns 202 Accepted.\n",
      );
    });

    const instruction = `Update ${TARGET} with the health status; match current implementation.`;
    function intent(preference: "implementation" | "documentation" | "unspecified") {
      const text =
        preference === "documentation"
          ? instruction.replace("current implementation", "documentation")
          : instruction;
      const record = recordedIntent(text, {
        operation: "update",
        targets: [{ path: TARGET, quote: TARGET }],
      });
      const { schemaVersion: _version, kind: _kind, digest: _digest, ...body } = record.intent!;
      return {
        text,
        record: {
          ...record,
          intent: sealRequestIntent({
            ...body,
            authorityPreference: {
              preference,
              quote:
                preference === "unspecified"
                  ? null
                  : quoteOf(
                      text,
                      preference === "implementation"
                        ? "match current implementation"
                        : "match documentation",
                    ),
            },
          }),
        },
      };
    }
    async function health(
      preference: "implementation" | "documentation" | "unspecified",
      sources = [
        { path: "docs/api.md", value: "202", text: "Health returns 202 Accepted.\n", valued: true },
        {
          path: "src/health.ts",
          value: "200",
          text: "export const healthStatus = 200;\n",
          valued: true,
        },
      ],
      missing = false,
    ) {
      const setup = await helperWorkspace({
        [TARGET]: "# Deployment\n",
        ...Object.fromEntries(sources.map((source) => [source.path, source.text])),
      });
      const bridge = contradictionBridge(
        (seeds, frames) =>
          seeds.map((seed) => {
            if (seed.id === "decomposed-health-probe")
              return {
                obligationId: seed.id,
                status: "missing",
                evidenceSpanIds: [],
                detail: "No health probe example was offered.",
              };
            const cited = sources.map((source) => ({
              ...source,
              spanId: frameWith(frames, source.path, source.text.trim()).id,
            }));
            return {
              obligationId: seed.id,
              status: seed.requiredSourceSupport ? "contradicted" : "supported",
              evidenceSpanIds: seed.requiredSourceSupport
                ? cited.map((source) => source.spanId)
                : [],
              detail: "Health statuses differ.",
              ...(seed.requiredSourceSupport
                ? {
                    sides: cited
                      .filter((source) => source.valued)
                      .map(({ spanId, value }) => ({ spanId, value })),
                  }
                : {}),
            };
          }),
        missing
          ? [
              {
                id: "decomposed-health-probe",
                origin: "inferred",
                instructionQuote: null,
                targetPaths: [TARGET],
                condition: "An example health probe for the service is documented.",
                requiredSourceSupport: true,
              },
            ]
          : [],
      );
      const bound = intent(preference);
      const result = await bindHelper(setup, bridge, {
        instruction: bound.text,
        requestIntent: bound.record,
      });
      return { setup, bridge, bound, result };
    }
    it("keeps the admitted grounded authority preference in the provider projection", () => {
      const bound = intent("implementation");
      expect(
        admittedFirstPassRequestIntent({
          workflow: "update-documentation",
          instruction: bound.text,
          requestIntent: bound.record,
        })?.authorityPreference,
      ).toEqual(bound.record.intent!.authorityPreference);
    });
    it.each(["implementation", "unspecified"] as const)(
      "proceeds through real binding with docs-stale under %s preference",
      async (preference) => {
        const fixture = await health(preference);
        expect(fixture.result).not.toBeInstanceOf(Error);
        expect(fixture.result).toMatchObject({ completed: true });
        const warnings =
          (fixture.result as { firstPassEvidenceWarnings?: string[] }).firstPassEvidenceWarnings ??
          [];
        expect(warnings.join("\n")).toContain("docs-stale:");
        expect(warnings.join("\n")).toContain("200");
        expect(warnings.join("\n")).toContain("202");
        expect(warnings.join("\n")).toContain("src/health.ts");
        expect(warnings.join("\n")).toContain("docs/api.md");
        const support = await recordedSupport(fixture.setup);
        expect(support.terminationReason).toBe("unresolved-obligations");
        expect(support.obligations.some((row) => row.status === "contradicted")).toBe(true);
      },
    );
    it("keeps ordinary gap warnings beside a resolved discrepancy through real binding", async () => {
      const fixture = await health("implementation", undefined, true);
      expect(fixture.result).toMatchObject({ completed: true });
      const lines = (
        fixture.result as { firstPassEvidenceWarnings: readonly string[] }
      ).firstPassEvidenceWarnings.join("\n");
      expect(lines).toContain("docs-stale:");
      expect(lines).toContain("decomposed-health-probe is missing");
      expect(
        (await recordedSupport(fixture.setup)).obligations.some(
          (row) => row.status === "contradicted",
        ),
      ).toBe(true);
    });
    it("proceeds on the admitted documentation preference with a neutral discrepancy label", async () => {
      const fixture = await health("documentation");
      expect(fixture.result).not.toBeInstanceOf(Error);
      const warnings =
        (fixture.result as { firstPassEvidenceWarnings?: string[] }).firstPassEvidenceWarnings ??
        [];
      expect(warnings.join("\n")).toContain("documentation preference; implementation differs");
      expect(warnings.join("\n")).toContain("202");
    });
    it.each(["implementation", "documentation", "unspecified"] as const)(
      "keeps unknown, fabricated, uncovered, and conflicting authorities unresolved under %s preference",
      async (preference) => {
        const source = (path: string, value: string, text = value, valued = true) => ({
          path,
          value,
          text,
          valued,
        });
        const doc = source("docs/api.md", "202");
        const code = source("src/health.ts", "200");
        for (const sources of [
          [doc, code, source("deploy.yaml", "9090")],
          [doc, source("notes/health.yaml", "200")],
          [doc, source("planning/health.md", "200")],
          [doc, source("docs/other.md", "200")],
          [doc, source("src/health.ts", "999", "200")],
          [doc, code, source("deploy.yaml", "9090", "9090", false)],
        ]) {
          const fixture = await health(preference, sources);
          expect(fixture.result, JSON.stringify(sources)).toBeInstanceOf(
            FirstPassSupportValidationError,
          );
          expect(fixture.result).toMatchObject({ code: "contradicted" });
        }
      },
    );

    it.each(["rst", "adoc", "asciidoc", "txt", "htm", "html", "xhtml"])(
      "recognizes scanned %s documentation without using source order",
      async (extension) => {
        const fixture = await health("implementation", [
          { path: "src/health.ts", value: "200", text: "200", valued: true },
          { path: `docs/api.${extension}`, value: "202", text: "202", valued: true },
        ]);
        expect(fixture.result).toMatchObject({ completed: true });
        expect(
          (
            fixture.result as { firstPassEvidenceWarnings: readonly string[] }
          ).firstPassEvidenceWarnings.join("\n"),
        ).toContain('chosen value: "200"');
      },
    );
    it("requires a unique documentation value for an explicit documentation preference", async () => {
      const sources = [
        { path: "docs/api.md", value: "202", text: "202", valued: true },
        { path: "docs/quickstart.md", value: "201", text: "201", valued: true },
        { path: "src/health.ts", value: "200", text: "200", valued: true },
      ];
      expect((await health("documentation", sources)).result).toMatchObject({
        code: "contradicted",
      });
      expect((await health("implementation", sources)).result).toMatchObject({ completed: true });
    });
    it("retains every escaped path and value across recordable discrepancy chunks", async () => {
      const docPath = `docs/${Array.from({ length: 5 }, () => "\u202e".repeat(60)).join("/")}/health.md`;
      const value = "202 ".repeat(50).trim();
      const fixture = await health("implementation", [
        { path: docPath, value, text: value, valued: true },
        { path: "src/health.ts", value: "200", text: "200", valued: true },
      ]);
      expect(fixture.result).toMatchObject({ completed: true });
      const lines = (fixture.result as { firstPassEvidenceWarnings: readonly string[] })
        .firstPassEvidenceWarnings;
      const reconstructed = lines
        .map((line) =>
          line.replace(/^docs-stale: discrepancy \d+, detail \d+: (?:part \d+: )?/u, ""),
        )
        .join("");
      expect(lines.every(isRecordableEvidenceWarning)).toBe(true);
      expect(reconstructed).toContain(escapeUndisplayable(JSON.stringify(docPath)));
      expect(reconstructed).toContain(JSON.stringify(value));
    });
  });
}
