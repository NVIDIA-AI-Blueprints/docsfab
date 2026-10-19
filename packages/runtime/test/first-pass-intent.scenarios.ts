// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * First pass binds its write targets from the admitted request intent: at the
 * shipped entry (`executeRunRequest` with an injected interpreter port), and
 * at the one gate `admittedFirstPassRequestIntent` for records the shipped
 * entry never hands it. The no-intent arm keeps the frozen parser, except that
 * a create naming no page asks instead of inventing one. An advisory reading,
 * one the run went on past, takes the no-intent arm.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);
const capture = vi.hoisted(() => ({ intercept: true, invocations: [] as unknown[] }));
const bridgeHolder = vi.hoisted(() => ({ bridge: undefined as unknown }));
const firstPassLog = vi.hoisted(() => ({ routes: [] as boolean[], entered: 0 }));
const STOP_AT_EXECUTION = "test sentinel: the run reached workflow execution";

vi.mock("../src/cli/first-pass.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass.js")>();
  return {
    ...actual,
    bindFirstRunProposalScope: async (
      ...args: Parameters<typeof actual.bindFirstRunProposalScope>
    ) => {
      order.push("proposal-scope");
      return actual.bindFirstRunProposalScope(...args);
    },
    needsFirstPassKnowledgeForExecution: async (
      ...args: Parameters<typeof actual.needsFirstPassKnowledgeForExecution>
    ) => {
      const routed = await actual.needsFirstPassKnowledgeForExecution(...args);
      firstPassLog.routes.push(routed);
      return routed;
    },
    bindFirstPassKnowledge: async (...args: Parameters<typeof actual.bindFirstPassKnowledge>) => {
      firstPassLog.entered += 1;
      return actual.bindFirstPassKnowledge(...args);
    },
  };
});

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
      if (!capture.intercept) return actual.executeWorkflowRun(...args);
      order.push("execute");
      capture.invocations.push(args[0]);
      throw new Error(STOP_AT_EXECUTION);
    },
  };
});

import {
  createKnowledgeAcceptedSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
  type KnowledgeAcceptedSnapshotV1,
} from "../src/canon/from-knowledge-snapshot.js";
import {
  admittedFirstPassRequestIntent,
  bindFirstPassKnowledge,
  bindFirstRunProposalScope,
  FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
  firstPassIntentWriteTargets,
  firstRunProposalTargetControl,
  needsFirstPassKnowledgeForExecution,
} from "../src/cli/first-pass.js";
import { inspectRequestedPageSupport } from "../src/cli/knowledge-resume.js";
import {
  firstPassAssessmentBindingSha256,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../src/cli/first-pass-support.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { assembleHostOperations } from "../src/cli/run/host-operations.js";
import type { CliRunInvocation, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import {
  computeSourceRequestSha256V3,
  projectSourceRequestContext,
  selectSourceRequestProjectionVersion,
} from "../src/inputs/source-evidence.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import type { RunRecordRequestIntentV1 } from "../src/request-intent/interpret-record.js";
import { pathTokenText, spanNamesPath } from "../src/request-intent/quote.js";
import { validateFirstPassTargetControl } from "../src/workflow-execution/runner-ports.js";
import {
  advisoryIntent,
  notInterpreted,
  recordedIntent,
  type IntentSpec,
} from "./helpers/first-pass-intent.js";
import { initFixtureRepo } from "./helpers/git.js";
import { validModelConfig } from "./helpers.js";
import { parseEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  PAGE_PATH,
  runRequest as sourceRunRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";

import type { FirstPassScenarioInputs } from "./helpers/runtime-scenario-inputs.js";

declare global {
  var __docsfabProviderParserCalls: string[] | undefined;
  var __docsfabScopeProbeCalls: string[] | undefined;
  var __docsfabGatherCalls: number | undefined;
  var __docsfabAuthorizationStop: boolean | undefined;
  var __docsfabStubProviderPage: string | undefined;
}

export function registerFirstPassIntentScenarios(inputs: FirstPassScenarioInputs): void {
  const UPDATE_TELEMETRY_CONFIGURATION = inputs.updateConfiguration;
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const knowledgeSource = resolve(runtimeRoot, "..", "knowledge", "src");
  const roots = temporaryRoots();
  const REVISION = "f".repeat(40);
  const KNOWLEDGE_DIR = process.env.DOCSFAB_KNOWLEDGE_DIR;
  /** A journey runs interpretation, first pass and up to three runs of the shipped entry. */
  const JOURNEY_MS = testTimeoutMs(30_000);

  const UPDATE_CLI_REFERENCE = inputs.updateReference;
  const CREATE_CLI_CONFIGURATION = inputs.createConfiguration;
  const CONFLICTING_SERVICE_PORT = inputs.conflictingServicePort;
  // The list form, and a merely mentioned agent file.
  const LIST_FORM =
    "Create five pages under docs/fern/pages/guides/: overview.mdx, install.mdx, configure.mdx, troubleshoot.mdx, faq.mdx.";
  const ACKNOWLEDGE_AGENTS = "Create docs/guide.md for operators and acknowledge AGENTS.md.";

  beforeEach(() => {
    order.length = 0;
    capture.intercept = true;
    capture.invocations.length = 0;
    bridgeHolder.bridge = undefined;
    firstPassLog.routes.length = 0;
    firstPassLog.entered = 0;
    globalThis.__docsfabProviderParserCalls = [];
    globalThis.__docsfabScopeProbeCalls = [];
    globalThis.__docsfabGatherCalls = 0;
    globalThis.__docsfabAuthorizationStop = false;
    globalThis.__docsfabStubProviderPage = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    if (KNOWLEDGE_DIR === undefined) delete process.env.DOCSFAB_KNOWLEDGE_DIR;
    else process.env.DOCSFAB_KNOWLEDGE_DIR = KNOWLEDGE_DIR;
  });

  /**
   * A configured knowledge provider (`DOCSFAB_KNOWLEDGE_DIR`) that counts the
   * early negative-scope probe separately from ordinary parsing. When a test
   * sets a page, it binds that page whatever the host passed: an older provider
   * that ignores the intent.
   */
  async function countingProvider(): Promise<void> {
    const directory = join(await roots.create("docsfab-intent-provider-"), "src");
    await mkdir(directory, { recursive: true });
    const real = (name: string) => JSON.stringify(pathToFileURL(join(knowledgeSource, name)).href);
    await writeFile(
      join(directory, "first-pass-support.mjs"),
      [
        `export * from ${real("first-pass-support.mjs")};`,
        `import { parseOrdinaryDocumentationRequest as parse } from ${real("first-pass-support.mjs")};`,
        "export function parseOrdinaryDocumentationRequest(input) {",
        "  if (input.purpose === 'negative-write-scope') {",
        "    (globalThis.__docsfabScopeProbeCalls ??= []).push(input.instruction);",
        "  } else {",
        "    (globalThis.__docsfabProviderParserCalls ??= []).push(input.instruction);",
        "  }",
        "  return parse(input);",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(directory, "first-pass.mjs"),
      [
        'import { createHash } from "node:crypto";',
        `import { gatherRepositoryFirstPass as gather } from ${real("first-pass.mjs")};`,
        `export * from ${real("first-pass.mjs")};`,
        "export async function gatherRepositoryFirstPass(input) {",
        "  globalThis.__docsfabGatherCalls = (globalThis.__docsfabGatherCalls ?? 0) + 1;",
        "  const page = globalThis.__docsfabStubProviderPage;",
        "  if (page === undefined) {",
        "    const result = await gather(input);",
        "    return globalThis.__docsfabAuthorizationStop ? { ...result, authorizationStop: { code: 'needs-authorization', message: 'fixture authorization stop' } } : result;",
        "  }",
        '  const instructionSha256 = createHash("sha256").update(input.instruction.normalize("NFC"), "utf8").digest("hex");',
        "  const { requestIntent: _ignored, ...rest } = input;",
        "  return gather({ ...rest, requestIntent: {",
        '    schemaVersion: 1, kind: "docsfab-first-pass-request-intent", instructionSha256,',
        '    operation: "create", writeTargets: [page], sources: [], preserve: [], exclusions: [], constraints: [],',
        "  } });",
        "}",
        "",
      ].join("\n"),
    );
    process.env.DOCSFAB_KNOWLEDGE_DIR = dirname(directory);
  }

  function parserCalls(): readonly string[] {
    return globalThis.__docsfabProviderParserCalls ?? [];
  }

  function scopeProbeCalls(): readonly string[] {
    return globalThis.__docsfabScopeProbeCalls ?? [];
  }

  function stubConfig(stateDirectory: string): DocsFabConfig {
    return {
      projectRoot: runtimeRoot,
      skillCrateDirectory: join(runtimeRoot, "skill-crate"),
      qualityDirectory: join(runtimeRoot, "quality"),
      qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      stateDirectory,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      model: validModelConfig,
    };
  }

  const PROJECT_CONFIG = {
    schemaVersion: 1,
    gitlab: { remote: "origin", defaultBranch: "main" },
    provider: { configuration: "host" },
    storage: { scope: "user-private" },
  };

  async function fixture(
    files: Readonly<Record<string, string>> = {},
    projectConfig: Record<string, unknown> = PROJECT_CONFIG,
  ): Promise<{ repositoryPath: string; stateDirectory: string }> {
    const root = await roots.create("docsfab-intent-first-pass-");
    const repositoryPath = join(root, "repo");
    await initFixtureRepo(repositoryPath, {
      "README.md": `# ${inputs.cliName}

Run \`${inputs.cliName} configure --endpoint URL --output json\` to write the operator configuration.
`,
      "docs/cli.md": "# CLI reference\n\nThe configure command writes the configuration.\n",
      "docs/deployment.md": "# Deployment\n\nDeploy the service.\n",
      "docs/release-notes.md": "# Release notes\n\nInitial release.\n",
      ".docsfab.json": `${JSON.stringify(projectConfig)}\n`,
      ...files,
    });
    return {
      repositoryPath,
      stateDirectory: await roots.create("docsfab-intent-first-pass-state-"),
    };
  }

  function request(
    repositoryPath: string,
    workflow: "create-documentation" | "update-documentation",
    instruction: string,
  ): RunRequestWithPublishProjection {
    return {
      workflow,
      repositoryPath,
      revision: "HEAD",
      instruction,
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      patchOnly: true,
    } as RunRequestWithPublishProjection;
  }

  /** An interpreter port that answers every call with `proposal`. */
  function port(proposal: Record<string, unknown>): RequestIntentInterpreterPort & {
    readonly calls: number[];
  } {
    const calls: number[] = [];
    return {
      calls,
      async call() {
        calls.push(calls.length + 1);
        order.push("interpret");
        return {
          text: JSON.stringify({
            authorityPreference: { preference: "unspecified", quote: null },
            ...proposal,
          }),
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
    };
  }

  async function run(
    runRequest: RunRequestWithPublishProjection,
    stateDirectory: string,
    interpreter: RequestIntentInterpreterPort,
  ): Promise<{ result?: RunRecord; error?: unknown }> {
    const log = console.log;
    const error = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      return {
        result: (await executeRunRequest(runRequest, stubConfig(stateDirectory), {
          requestInterpreter: interpreter,
        })) as RunRecord,
      };
    } catch (caught) {
      return { error: caught };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  function captured(): CliRunInvocation {
    expect(capture.invocations, "the run never reached workflow execution").toHaveLength(1);
    return capture.invocations[0] as CliRunInvocation;
  }

  const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

  /** Supports every obligation from the first offered span; no provider is called. */
  function scriptedSupportBridge(): FirstPassSupportModelBridge {
    let lastIdentitySha256: string | undefined;
    let lastAssessmentBindingSha256: string | undefined;
    return {
      call: async (call: FirstPassSupportModelRequest) => {
        let value: unknown;
        if (call.prompt.startsWith("Phase: obligation-decomposition")) {
          value = { schemaVersion: 1, additionalObligations: [] };
        } else if (call.prompt.startsWith("Phase: obligation-completeness-audit")) {
          value = { schemaVersion: 1, complete: true, omissions: [] };
        } else {
          const line = call.prompt
            .split("\n")
            .find((entry) => entry.startsWith("Mandatory obligations: "))!;
          const obligations = JSON.parse(line.slice("Mandatory obligations: ".length)) as Array<{
            id: string;
            requiredSourceSupport: boolean;
          }>;
          const firstSpan = parseEvidenceFrames(call.prompt)[0]!.id;
          value = {
            schemaVersion: 1,
            assessments: obligations.map((obligation) => ({
              obligationId: obligation.id,
              status: "supported",
              evidenceSpanIds: obligation.requiredSourceSupport ? [firstSpan] : [],
              detail: "Supported by the offered repository span.",
            })),
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
          lastAssessmentBindingSha256 = firstPassAssessmentBindingSha256(
            call.prompt,
            responseText,
            parseEvidenceFrames,
          );
        }
        return { responseText, identity, usage: { inputTokens: 20, outputTokens: 10 } };
      },
      lastAssessmentIdentitySha256: () => lastIdentitySha256,
      lastAssessmentBindingSha256: () => lastAssessmentBindingSha256,
    };
  }

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

  function controlPaths(invocation: CliRunInvocation): readonly string[] {
    const control = invocation.firstPassTargetControl;
    expect(control, "no first-pass target control reached execution").toBeDefined();
    // The runner's own verification of the control the host built.
    return validateFirstPassTargetControl(control, {
      ...invocation.request,
      repository: {
        sourcePath: invocation.request.repositoryPath,
        revision: control!.repositoryRevision,
      },
    } as never)!.targetPaths;
  }

  describe("write targets from the admitted intent, through executeRunRequest", {
    timeout: JOURNEY_MS,
  }, () => {
    it("binds the pilot update to the page the intent chose, never a page built from its words (row 1)", async () => {
      await countingProvider();
      // Supports a first pass if the route ever took one; only the read-only
      // destination probe may call the provider before admitted binding.
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const outcome = await run(
        request(repositoryPath, "update-documentation", UPDATE_CLI_REFERENCE),
        stateDirectory,
        port({
          operation: "update",
          targets: [
            {
              path: "docs/cli.md",
              role: "write",
              chosenFrom: "inventory",
              quote: "the CLI reference",
            },
          ],
        }),
      );
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      const invocation = captured();
      expect(invocation.request.requestIntent?.admission.outcome).toBe("admitted");
      const paths = controlPaths(invocation);
      expect(paths).toEqual(["docs/cli.md"]);
      // The pilot slug was docs/cli-reference-to-match.md.
      expect(paths.some((path) => path.startsWith("docs/cli-reference"))).toBe(false);
      expect(parserCalls(), "an admitted intent reached the request parser").toEqual([]);
      expect(scopeProbeCalls()).toEqual([UPDATE_CLI_REFERENCE]);
    });

    it("binds the deployment page the intent chose for the conflicting-port request (row 3)", async () => {
      await countingProvider();
      // Supports a first pass if the route ever took one, so no provider is called.
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const outcome = await run(
        request(repositoryPath, "update-documentation", CONFLICTING_SERVICE_PORT),
        stateDirectory,
        port({
          operation: "update",
          targets: [
            {
              path: "docs/deployment.md",
              role: "write",
              chosenFrom: "inventory",
              quote: "the deployment guide",
            },
          ],
        }),
      );
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/deployment.md"]);
      expect(parserCalls()).toEqual([]);
    });

    it("binds only the admitted new page of the pilot create after gathering support (row 2)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const outcome = await run(
        request(repositoryPath, "create-documentation", CREATE_CLI_CONFIGURATION),
        stateDirectory,
        port({
          operation: "create",
          targets: [
            {
              path: "docs/cli-configuration.md",
              role: "write",
              chosenFrom: "proposed-new",
              quote: inputs.createShortQuote,
            },
          ],
        }),
      );
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/cli-configuration.md"]);
      expect(order).toEqual(["interpret", "proposal-scope", "execute"]);
      expect(parserCalls()).toEqual([]);
    });

    it("binds a list of section pages as full paths, sorted, whatever order the model gave (rows 4 and 14)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const names = ["troubleshoot", "overview", "install", "faq", "configure"];
      const outcome = await run(
        request(repositoryPath, "create-documentation", LIST_FORM),
        stateDirectory,
        port({
          operation: "create",
          // Reverse of the runner's order: the host sorts before the control.
          targets: names.map((name) => ({
            path: `docs/fern/pages/guides/${name}.mdx`,
            role: "write",
            chosenFrom: "proposed-new",
            quote: `${name}.mdx`,
          })),
        }),
      );
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(
        [...names].sort().map((name) => `docs/fern/pages/guides/${name}.mdx`),
      );
      expect(parserCalls()).toEqual([]);
    });

    it("binds the named page and not a merely mentioned agent file (row 4)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const outcome = await run(
        request(repositoryPath, "create-documentation", ACKNOWLEDGE_AGENTS),
        stateDirectory,
        port({
          operation: "create",
          targets: [
            { path: "docs/guide.md", role: "write", chosenFrom: "named", quote: "docs/guide.md" },
          ],
        }),
      );
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/guide.md"]);
    });

    it("stops a page named twice at interpretation, before any binding (row 4)", async () => {
      await countingProvider();
      const { repositoryPath, stateDirectory } = await fixture();
      const target = {
        path: "docs/guide.md",
        role: "write",
        chosenFrom: "named",
        quote: "docs/guide.md",
      };
      const outcome = await run(
        request(repositoryPath, "create-documentation", ACKNOWLEDGE_AGENTS),
        stateDirectory,
        port({ operation: "create", targets: [target, target] }),
      );
      const record = outcome.result!;
      expect(record.requestIntent?.admission).toMatchObject({
        outcome: "rejected",
        code: "request-intent-duplicate-target",
      });
      expect(order).toEqual(["interpret"]);
      expect(parserCalls()).toEqual([]);
    });

    it("goes on past a model question as an advisory, and binds none of its reading (row 11)", async () => {
      await countingProvider();
      // Supports a first pass if the route ever took one, so no provider is called.
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const outcome = await run(
        request(repositoryPath, "update-documentation", UPDATE_CLI_REFERENCE),
        stateDirectory,
        port({
          operation: "update",
          targets: [
            {
              path: "docs/cli.md",
              role: "write",
              chosenFrom: "inventory",
              quote: "the CLI reference",
            },
          ],
          questions: [
            {
              question: "Which reference page should change?",
              options: ["docs/cli.md", "docs/release-notes.md"],
              recommendedDefault: "docs/cli.md",
              consequence: "Only docs/cli.md changes.",
            },
          ],
        }),
      );
      expect((outcome.error as Error | undefined)?.message).toBe(STOP_AT_EXECUTION);
      const invocation = captured();
      expect(invocation.request.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-model-question",
      });
      // The reading chose docs/cli.md, and the admitted row 1 binds it; an
      // advisory binds nothing. The request names no page, so first pass read
      // the words, as without an intent, and the update keeps its planner route.
      expect(invocation.firstPassTargetControl).toBeUndefined();
      expect(order).toEqual(["interpret", "proposal-scope", "execute"]);
      expect(parserCalls().length, "first pass never read the request").toBeGreaterThan(0);
    });

    it("asks a create once for its page: at the interpretation, or in first pass after an advisory (D5)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      // A reading that names no page stops at the interpretation; first pass
      // never runs, so it cannot ask again.
      const unnamed = await run(
        request(repositoryPath, "create-documentation", CREATE_CLI_CONFIGURATION),
        stateDirectory,
        port({ operation: "create", targets: [] }),
      );
      expect(unnamed.result?.status).toBe("needs-input");
      expect(unnamed.result?.requestIntent?.admission).toMatchObject({
        outcome: "question",
        code: "request-intent-target-missing",
      });
      expect(order).toEqual(["interpret"]);
      expect(parserCalls()).toEqual([]);
      // A reading that proposes a page but asks a question goes on as an
      // advisory and binds nothing; the words name no page, so first pass
      // asks, as it does without an intent.
      order.length = 0;
      const advisory = await run(
        request(repositoryPath, "create-documentation", CREATE_CLI_CONFIGURATION),
        stateDirectory,
        port({
          operation: "create",
          targets: [
            {
              path: "docs/cli-configuration.md",
              role: "write",
              chosenFrom: "proposed-new",
              quote: inputs.createShortQuote,
            },
          ],
          questions: [
            {
              question: "Should the guide also cover the output formats?",
              options: ["yes", "no"],
              recommendedDefault: "yes",
              consequence: "The guide covers the output formats.",
            },
          ],
        }),
      );
      expect(advisory.error).toMatchObject({ code: "ambiguous-targets" });
      expect((advisory.error as Error).message).toContain("does not invent one");
      expect((advisory.error as Error).message).not.toContain("docs/cli-configuration.md");
      expect(order).toEqual(["interpret", "proposal-scope"]);
      expect(capture.invocations).toHaveLength(0);
      expect(parserCalls().length).toBeGreaterThan(0);
    });

    it("relies on admission's existence answers: an absent update page and a present create page stop (D8)", async () => {
      const { repositoryPath, stateDirectory } = await fixture();
      const absent = await run(
        request(repositoryPath, "update-documentation", "Update docs/missing.md with the flags."),
        stateDirectory,
        port({
          operation: "update",
          targets: [
            {
              path: "docs/missing.md",
              role: "write",
              chosenFrom: "named",
              quote: "docs/missing.md",
            },
          ],
        }),
      );
      expect(absent.result?.requestIntent?.admission.code).toBe("request-intent-target-absent");
      const present = await run(
        request(repositoryPath, "create-documentation", "Create docs/cli.md for operators."),
        stateDirectory,
        port({
          operation: "create",
          targets: [
            { path: "docs/cli.md", role: "write", chosenFrom: "named", quote: "docs/cli.md" },
          ],
        }),
      );
      expect(present.result?.requestIntent?.admission.code).toBe("request-intent-target-present");
      expect(order.filter((step) => step === "proposal-scope")).toEqual([]);
    });

    it.each(["single", "mixed"] as const)(
      "preserves the protected-page refusal before interpreting %s destinations (row 14)",
      async (form) => {
        // An agent instruction page remains protected under a configured docs root.
        // The negative probe preserves its owner-specific refusal before interpretation.
        const { repositoryPath, stateDirectory } = await fixture(
          { "site/content/AGENTS.md": "# Agents\n", "site/content/install.md": "# Install\n" },
          { ...PROJECT_CONFIG, documentationRoots: ["site/content"] },
        );
        const interpreter = port({
          operation: "update",
          targets: [
            {
              path: "site/content/AGENTS.md",
              role: "write",
              chosenFrom: "named",
              quote: "site/content/AGENTS.md",
            },
          ],
        });
        const outcome = await run(
          request(
            repositoryPath,
            "update-documentation",
            `Update site/content/AGENTS.md${form === "mixed" ? " and src/notes.md" : ""} with the flags.`,
          ),
          stateDirectory,
          interpreter,
        );
        expect(outcome.error).toMatchObject({
          name: "FirstRunProposalScopeError",
          code: "proposal-scope-unsafe-target",
          phase: "proposal-scope-admission",
          noWorkPerformed: true,
        });
        expect(interpreter.calls).toHaveLength(0);
        expect((outcome.error as Error).message).toContain("site/content/AGENTS.md");
        if (form === "mixed") expect((outcome.error as Error).message).toContain("src/notes.md");
        expect(capture.invocations).toHaveLength(0);
        // Positive control: a page the rule admits under the same root binds.
        const admitted = await run(
          request(
            repositoryPath,
            "update-documentation",
            "Update site/content/install.md with the flags.",
          ),
          stateDirectory,
          port({
            operation: "update",
            targets: [
              {
                path: "site/content/install.md",
                role: "write",
                chosenFrom: "named",
                quote: "site/content/install.md",
              },
            ],
          }),
        );
        expect((admitted.error as Error).message).toBe(STOP_AT_EXECUTION);
        expect(controlPaths(captured())).toEqual(["site/content/install.md"]);
      },
    );

    it("keeps the request's own narrowing: a page it names only as not to change refuses (row 15)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const instruction = "Update docs/cli.md with the flags. Do not change docs/release-notes.md.";
      const named = (path: string) => ({ path, role: "write", chosenFrom: "named", quote: path });
      const widened = await run(
        request(repositoryPath, "update-documentation", instruction),
        stateDirectory,
        port({
          operation: "update",
          targets: [named("docs/cli.md"), named("docs/release-notes.md")],
        }),
      );
      // Admission accepts the model's reading; the request's negation still narrows it.
      expect(widened.error).toMatchObject({ code: "proposal-scope-non-actionable-targets" });
      expect(capture.invocations).toHaveLength(0);
      expect(parserCalls(), "the guard re-parsed the request").toEqual([]);
      // Adjacent: the same request with only the page it asks to change binds it.
      const narrowed = await run(
        request(repositoryPath, "update-documentation", instruction),
        stateDirectory,
        port({ operation: "update", targets: [named("docs/cli.md")] }),
      );
      expect((narrowed.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/cli.md"]);
      // Adjacent: a page named once as not to change and once as a change binds,
      // and so does the actionable control, whose "rewrite" the guard does not read as a write.
      for (const mixed of [
        "Do not change docs/cli.md's title; update docs/cli.md with the flags.",
        "Do not rewrite docs/cli.md from scratch; update docs/cli.md with the flags.",
      ]) {
        capture.invocations.length = 0;
        const both = await run(
          request(repositoryPath, "update-documentation", mixed),
          stateDirectory,
          port({
            operation: "update",
            targets: [
              {
                path: "docs/cli.md",
                role: "write",
                chosenFrom: "named",
                quote: "update docs/cli.md",
              },
            ],
          }),
        );
        expect((both.error as Error).message, mixed).toBe(STOP_AT_EXECUTION);
        expect(controlPaths(captured()), mixed).toEqual(["docs/cli.md"]);
      }
    });

    it("keeps the request's narrowing for every path form admission grounds (row 15)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture({
        "docs/a.md": "# A\n\nA page.\n",
      });
      const write = (path: string, quote: string, chosenFrom = "named") => ({
        path,
        role: "write",
        chosenFrom,
        quote,
      });
      const cli = write("docs/cli.md", "docs/cli.md");
      for (const [instruction, target] of [
        [
          "Update docs/cli.md with the flags. Do not change ./docs/release-notes.md.",
          write("docs/release-notes.md", "./docs/release-notes.md"),
        ],
        [
          "Update docs/cli.md with the flags. Do not change docs/release-notes.md#install.",
          write("docs/release-notes.md", "docs/release-notes.md#install"),
        ],
        [
          "Update docs/cli.md with the flags. Do not change docs/release-notes.md。",
          write("docs/release-notes.md", "docs/release-notes.md"),
        ],
        [
          "Update docs/cli.md with the flags. Do not touch docs/a.md.",
          write("docs/a.md", "docs/a.md"),
        ],
        [
          "Update docs/cli.md with the flags. Do not change [the page](./docs/a.md).",
          write("docs/a.md", "./docs/a.md"),
        ],
        // Named grounding is exact case; an inventory page still meets the case fold.
        [
          "Update docs/cli.md with the flags. Do not change DOCS/A.md.",
          write("docs/a.md", "Do not change DOCS/A.md", "inventory"),
        ],
      ] as const) {
        capture.invocations.length = 0;
        const outcome = await run(
          request(repositoryPath, "update-documentation", instruction),
          stateDirectory,
          port({ operation: "update", targets: [cli, target] }),
        );
        expect(outcome.error, instruction).toMatchObject({
          code: "proposal-scope-non-actionable-targets",
        });
        expect(capture.invocations, instruction).toHaveLength(0);
      }
      expect(parserCalls(), "the guard re-parsed the request").toEqual([]);
    });

    it("drops a page the request keeps unchanged, as the no-intent arm does (row 15)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture({
        "docs/a.md": "# A\n\nA page.\n",
      });
      const write = (path: string, quote: string) => ({
        path,
        role: "write",
        chosenFrom: "named",
        quote,
      });
      const cli = write("docs/cli.md", "docs/cli.md");
      for (const [instruction, kept] of [
        [
          "Update docs/cli.md with the flags. Leave ./docs/a.md unchanged.",
          write("docs/a.md", "./docs/a.md"),
        ],
        ["Update docs/cli.md; keep docs/a.md unchanged.", write("docs/a.md", "docs/a.md")],
      ] as const) {
        capture.invocations.length = 0;
        const widened = await run(
          request(repositoryPath, "update-documentation", instruction),
          stateDirectory,
          port({ operation: "update", targets: [cli, kept] }),
        );
        expect(widened.error, instruction).toMatchObject({
          code: "proposal-scope-non-actionable-targets",
        });
        expect(capture.invocations, instruction).toHaveLength(0);
        // The page the request asks to change proceeds.
        const narrowed = await run(
          request(repositoryPath, "update-documentation", instruction),
          stateDirectory,
          port({ operation: "update", targets: [cli] }),
        );
        expect((narrowed.error as Error).message, instruction).toBe(STOP_AT_EXECUTION);
        expect(controlPaths(captured()), instruction).toEqual(["docs/cli.md"]);
      }
      // Asked to change: "unchanged" in another clause keeps no page, so both bind.
      capture.invocations.length = 0;
      const asked = "Update docs/cli.md and docs/a.md; keep the examples unchanged.";
      const both = await run(
        request(repositoryPath, "update-documentation", asked),
        stateDirectory,
        port({ operation: "update", targets: [cli, write("docs/a.md", "docs/a.md")] }),
      );
      expect((both.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/a.md", "docs/cli.md"]);
      expect(parserCalls(), "the guard re-parsed the request").toEqual([]);
    });

    it("keeps a deferral the path form hides from the bare-path reading (row 15)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture({
        "docs/a.md": "# A\n\nA page.\n",
      });
      const write = (path: string, quote: string) => ({
        path,
        role: "write",
        chosenFrom: "named",
        quote,
      });
      const cli = write("docs/cli.md", "docs/cli.md");
      for (const [instruction, deferred] of [
        [
          "Update docs/cli.md with the flags. Update docs/a.md#install later.",
          write("docs/a.md", "docs/a.md#install"),
        ],
        [
          "Update docs/cli.md with the flags. Update （docs/a.md） later.",
          write("docs/a.md", "docs/a.md"),
        ],
      ] as const) {
        capture.invocations.length = 0;
        const widened = await run(
          request(repositoryPath, "update-documentation", instruction),
          stateDirectory,
          port({ operation: "update", targets: [cli, deferred] }),
        );
        expect(widened.error, instruction).toMatchObject({
          code: "proposal-scope-non-actionable-targets",
        });
        expect(capture.invocations, instruction).toHaveLength(0);
        // The page the request asks to change now proceeds.
        const narrowed = await run(
          request(repositoryPath, "update-documentation", instruction),
          stateDirectory,
          port({ operation: "update", targets: [cli] }),
        );
        expect((narrowed.error as Error).message, instruction).toBe(STOP_AT_EXECUTION);
        expect(controlPaths(captured()), instruction).toEqual(["docs/cli.md"]);
      }
      expect(parserCalls(), "the guard re-parsed the request").toEqual([]);
    });

    it("binds every page a request asks to change after a keep or leave clause (row 15)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture({
        "docs/a.md": "# A\n\nA page.\n",
      });
      const write = (path: string) => ({ path, role: "write", chosenFrom: "named", quote: path });
      for (const [instruction, pages] of [
        [
          "Keep the examples unchanged and update docs/cli.md and docs/a.md with the new flags.",
          ["docs/a.md", "docs/cli.md"],
        ],
        ["Leave the intro unchanged and update docs/a.md.", ["docs/a.md"]],
      ] as const) {
        capture.invocations.length = 0;
        const bound = await run(
          request(repositoryPath, "update-documentation", instruction),
          stateDirectory,
          port({ operation: "update", targets: pages.map(write) }),
        );
        expect((bound.error as Error).message, instruction).toBe(STOP_AT_EXECUTION);
        expect(controlPaths(captured()), instruction).toEqual(pages);
      }
      expect(parserCalls(), "the guard re-parsed the request").toEqual([]);
    });

    it("refuses an admitted intent when the provider cannot apply the narrowing guard", async () => {
      const { repositoryPath, stateDirectory } = await fixture();
      const instruction = "Update docs/cli.md with the flags.";
      const intentPort = () =>
        port({
          operation: "update",
          targets: [
            { path: "docs/cli.md", role: "write", chosenFrom: "named", quote: "docs/cli.md" },
          ],
        });
      // An older provider without the guard, and one whose guard answers no list.
      // Both expose a deferring negative-scope parser so this test reaches the
      // intended guard contract after the early probe.
      for (const [label, body, message] of [
        ["missing", "export const unrelated = 1;\n", /missing a nonActionableNamedTargets export/u],
        [
          "not a list",
          'export function nonActionableNamedTargets() { return "docs/cli.md"; }\n',
          /returned no page list/u,
        ],
      ] as const) {
        const directory = join(await roots.create("docsfab-intent-guardless-"), "src");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "first-pass-support.mjs"),
          `export function parseOrdinaryDocumentationRequest() { return undefined; }\n${body}`,
        );
        process.env.DOCSFAB_KNOWLEDGE_DIR = dirname(directory);
        const outcome = await run(
          request(repositoryPath, "update-documentation", instruction),
          stateDirectory,
          intentPort(),
        );
        expect(outcome.error, label).toMatchObject({ code: "knowledge-provider-unavailable" });
        expect((outcome.error as Error).message, label).toMatch(message);
        expect(capture.invocations, label).toHaveLength(0);
      }
    });

    it("refuses support that binds a page of its own when nothing was bound (row 14)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      globalThis.__docsfabStubProviderPage = "docs/get-started.md";
      // Offline: no intent, and the frozen parser names no page in this request.
      const { repositoryPath, stateDirectory } = await fixture();
      const offline = await executeOffline(
        request(repositoryPath, "create-documentation", "Create a get-started page."),
        stateDirectory,
      );
      expect(offline.error).toMatchObject({ code: "support-binding-mismatch" });
      expect(capture.invocations).toHaveLength(0);
      // Adjacent: with an admitted intent the same provider page is still not the bound page.
      const admitted = await run(
        request(repositoryPath, "create-documentation", "Create a get-started page."),
        stateDirectory,
        port({
          operation: "create",
          targets: [
            {
              path: "docs/start.md",
              role: "write",
              chosenFrom: "proposed-new",
              quote: "get-started page",
            },
          ],
        }),
      );
      expect(admitted.error).toMatchObject({ code: "support-binding-mismatch" });
      // Positive control: the provider binding the admitted page passes.
      globalThis.__docsfabStubProviderPage = "docs/start.md";
      const matching = await run(
        request(repositoryPath, "create-documentation", "Create a get-started page."),
        stateDirectory,
        port({
          operation: "create",
          targets: [
            {
              path: "docs/start.md",
              role: "write",
              chosenFrom: "proposed-new",
              quote: "get-started page",
            },
          ],
        }),
      );
      expect((matching.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/start.md"]);
    });

    it("asks for the page of a path-less create without an intent, offline (row 8)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const { repositoryPath, stateDirectory } = await fixture();
      const offline = await executeOffline(
        request(repositoryPath, "create-documentation", CREATE_CLI_CONFIGURATION),
        stateDirectory,
      );
      expect(offline.error).toMatchObject({ code: "ambiguous-targets" });
      expect((offline.error as Error).message).toContain("does not invent one");
      expect(capture.invocations).toHaveLength(0);
      // The frozen parser still read the request: this is the no-intent arm.
      expect(parserCalls().length).toBeGreaterThan(0);
    });
  });

  describe("only the interpretation step's own result reaches first pass", {
    timeout: JOURNEY_MS,
  }, () => {
    it("drops an intent the caller set on the request, whatever the step recorded", async () => {
      const { repositoryPath, stateDirectory } = await fixture();
      const forged = recordedIntent("Create docs/guide.md for operators.", {
        operation: "create",
        targets: [{ path: "docs/guide.md", quote: "docs/guide.md" }],
      });
      // Write not granted: the step records nothing, so the field must not survive.
      const unrecorded = await executeOffline(
        {
          ...request(repositoryPath, "create-documentation", "Create docs/guide.md for operators."),
          allowWrite: false,
          requestIntent: forged,
        },
        stateDirectory,
      );
      expect((unrecorded.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(captured().request.requestIntent).toBeUndefined();
      // Adjacent: offline, the step's own record replaces the caller's.
      capture.invocations.length = 0;
      const offline = await executeOffline(
        {
          ...request(repositoryPath, "update-documentation", "Update docs/cli.md with the flags."),
          requestIntent: forged,
        },
        stateDirectory,
      );
      expect((offline.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(captured().request.requestIntent?.admission.outcome).toBe("offline");
    });
  });

  /** The shipped entry with no port, under the suite's `PI_OFFLINE=1`. */
  async function executeOffline(
    runRequest: RunRequestWithPublishProjection,
    stateDirectory: string,
  ): Promise<{ result?: RunRecord; error?: unknown }> {
    expect(process.env.PI_OFFLINE).toBe("1");
    try {
      return {
        result: (await executeRunRequest(runRequest, stubConfig(stateDirectory))) as RunRecord,
      };
    } catch (caught) {
      return { error: caught };
    }
  }

  describe("the one intent gate, for records the shipped entry never hands first pass (rows 5 and 6, helper level)", () => {
    const instruction = "Create docs/guide.md and docs/Guide.md for operators.";
    const spec = {
      operation: "create" as const,
      targets: [{ path: "docs/guide.md", quote: "docs/guide.md" }],
    };
    const gate = (requestIntent: unknown, text = instruction) =>
      admittedFirstPassRequestIntent(
        {
          workflow: "create-documentation",
          instruction: text,
          requestIntent: requestIntent as RunRecordRequestIntentV1,
        },
        REVISION,
      );

    it("binds only an admitted outcome, never a question's sealed intent (G1)", () => {
      expect(gate(recordedIntent(instruction, spec))?.writeTargets).toEqual(["docs/guide.md"]);
      const question = recordedIntent(
        instruction,
        {
          ...spec,
          question: {
            question: "Which page?",
            options: ["docs/guide.md"],
            recommendedDefault: "docs/guide.md",
            consequence: "Only docs/guide.md changes.",
          },
        },
        "question",
      );
      expect(question.intent, "the question record carries a sealed intent").not.toBeNull();
      for (const stopped of [
        question,
        recordedIntent(instruction, spec, "rejected"),
        recordedIntent(instruction, spec, "refused"),
        recordedIntent(instruction, spec, "unavailable"),
      ]) {
        expect(() => gate(stopped), stopped.admission.outcome).toThrow(
          expect.objectContaining({ code: "proposal-scope-binding-mismatch" }),
        );
      }
      // The no-intent arm: nothing to bind, and no refusal.
      for (const outcome of ["offline", "not-applicable", "continuation"] as const) {
        expect(gate(notInterpreted(outcome)), outcome).toBeUndefined();
      }
      expect(gate(undefined)).toBeUndefined();
    });

    it("binds nothing from an advisory reading, for any workflow: first pass reads the request (G3)", () => {
      const question = {
        question: "Which page?",
        options: ["docs/guide.md"],
        recommendedDefault: "docs/guide.md",
        consequence: "Only docs/guide.md changes.",
      };
      const readings = [
        ["request-intent-target-missing", { operation: "update", targets: [] }],
        ["request-intent-operation-mismatch", { ...spec, operation: "review" }],
        ["request-intent-model-question", { ...spec, question }],
      ] as const;
      for (const workflow of [
        "create-documentation",
        "update-documentation",
        "restructure-documentation",
      ] as const) {
        for (const [code, reading] of readings) {
          const advisory = advisoryIntent(instruction, reading, code);
          expect(
            admittedFirstPassRequestIntent(
              { workflow, instruction, requestIntent: advisory },
              REVISION,
            ),
            `${workflow} ${code}`,
          ).toBeUndefined();
        }
      }
    });

    it("refuses an admitted intent whose operation is not the workflow's", () => {
      const admitted = recordedIntent(instruction, spec);
      expect(() =>
        admittedFirstPassRequestIntent(
          { workflow: "update-documentation", instruction, requestIntent: admitted },
          REVISION,
        ),
      ).toThrow(expect.objectContaining({ code: "proposal-scope-binding-mismatch" }));
      // Adjacent: the declared create reads the same record.
      expect(gate(admitted)?.operation).toBe("create");
    });

    it("refuses a deferred RST update before the admitted write scope is bound", async () => {
      const instruction = "Update docs/a.rst and docs/b.rst later.";
      const requestIntent = recordedIntent(instruction, {
        operation: "update",
        targets: [{ path: "docs/a.rst", quote: "docs/a.rst" }],
      });
      await expect(
        bindFirstRunProposalScope({
          request: {
            ...request("/tmp/repo", "update-documentation", instruction),
            requestIntent,
          },
          config: stubConfig(await roots.create("docsfab-intent-rst-deferral-")),
          revision: REVISION,
          rstUpdatePaths: ["docs/a.rst"],
        }),
      ).rejects.toMatchObject({ code: "proposal-scope-non-actionable-targets" });
    });

    it("refuses an intent that does not verify against the instruction, and nothing else (G2)", () => {
      const admitted = recordedIntent(instruction, spec);
      const tampered = structuredClone(admitted) as unknown as {
        intent: { targets: { path: string }[] };
      };
      tampered.intent.targets[0]!.path = "docs/other.md";
      expect(() => gate(tampered)).toThrow(
        expect.objectContaining({ code: "proposal-scope-binding-mismatch" }),
      );
      expect(() => gate(admitted, `${instruction} Also add a FAQ.`)).toThrow(
        expect.objectContaining({ code: "proposal-scope-binding-mismatch" }),
      );
      // Adjacent: a failure that is not a contract fault passes through unchanged.
      const broken = {
        ...admitted,
        get admission(): never {
          throw new TypeError("record read failed");
        },
      };
      expect(() => gate(broken)).toThrow(new TypeError("record read failed"));
    });

    it("writes role write targets only, less exclusions, one spelling per folded path (B1, B5)", () => {
      const companion = recordedIntent("Create docs/guide.md and link it from docs/index.md.", {
        operation: "create",
        targets: [
          { path: "docs/guide.md", quote: "docs/guide.md" },
          {
            path: "docs/index.md",
            role: "companion-nav",
            chosenFrom: "named",
            quote: "docs/index.md",
          },
        ],
      });
      expect(
        admittedFirstPassRequestIntent(
          {
            workflow: "create-documentation",
            instruction: "Create docs/guide.md and link it from docs/index.md.",
            requestIntent: companion,
          },
          REVISION,
        )?.writeTargets,
      ).toEqual(["docs/guide.md"]);
      // Admission and the seal both refuse an excluded or case-folded duplicate
      // target, so these reach the write set only from an unverified body.
      const quote = { text: "x", start: 0, end: 1 };
      const target = (path: string, role: "write" | "companion-index" = "write") => ({
        path,
        role,
        chosenFrom: "named" as const,
        quote,
      });
      expect(
        firstPassIntentWriteTargets({
          targets: [
            target("docs/z.md"),
            target("docs/a.md"),
            target("docs/A.md"),
            target("docs/b/c.md"),
          ],
          exclusions: [{ path: "docs/b", quote }],
        }),
      ).toEqual(["docs/a.md", "docs/z.md"]);
      expect(
        firstPassIntentWriteTargets({
          targets: [target("docs/i.md", "companion-index")],
          exclusions: [],
        }),
      ).toEqual([]);
    });

    it("keeps the runner's NFC instruction digest for an NFD request (H1)", async () => {
      const nfd = "Create docs/café.md for operators.".normalize("NFD");
      expect(nfd).not.toBe(nfd.normalize("NFC"));
      const runRequest = {
        ...request("/tmp/repo", "create-documentation", nfd),
        requestIntent: recordedIntent(nfd, {
          operation: "create",
          targets: [{ path: "docs/guide.md", quote: "for operators" }],
        }),
      };
      const scope = await bindFirstRunProposalScope({
        request: runRequest,
        config: stubConfig(await roots.create("docsfab-intent-nfd-")),
        revision: REVISION,
      });
      const control = firstRunProposalTargetControl(scope!);
      expect(control.instructionSha256).toBe(sha(nfd.normalize("NFC")));
      expect(
        validateFirstPassTargetControl(control, {
          ...runRequest,
          repository: { sourcePath: "/tmp/repo", revision: REVISION },
        } as never)?.targetPaths,
      ).toEqual(["docs/guide.md"]);
    });
  });

  describe("the narrowing guard sees every mention admission grounds (row 15, parity)", () => {
    type Guard = (instruction: string, targetPaths: readonly string[]) => unknown;

    async function knowledgeGuard(): Promise<Guard> {
      const module = (await import(
        pathToFileURL(join(knowledgeSource, "first-pass-support.mjs")).href
      )) as { nonActionableNamedTargets: Guard };
      return module.nonActionableNamedTargets;
    }

    /** Whether admission's named grounding reads `path` anywhere in the request. */
    function admissionNames(instruction: string, path: string): boolean {
      const text = instruction.normalize("NFC");
      return spanNamesPath(pathTokenText(text), { start: 0, end: text.length }, path);
    }

    it("refuses a negated page in each form admission grounds, and only those", async () => {
      const guard = await knowledgeGuard();
      const pages = ["docs/cli.md", "docs/a.md"];
      const grounded = [
        "docs/a.md.",
        "./docs/a.md.",
        "`docs/a.md`.",
        "[the page](docs/a.md).",
        "(docs/a.md).",
        "docs/a.md#install.",
        "docs/a.md!",
        "docs/a.md?",
        "docs/a.md;",
        "docs/a.md:",
        "docs/a.md,",
        "docs/a.md",
        "docs/a.md。",
        "「docs/a.md」.",
        "docs/a.md的标题.",
        "文档docs/a.md.",
      ];
      for (const form of grounded) {
        const instruction = `Update docs/cli.md with the flags. Do not change ${form}`;
        expect(admissionNames(instruction, "docs/a.md"), form).toBe(true);
        expect(guard(instruction, pages), form).toEqual(["docs/a.md"]);
      }
      for (const form of ["docs/a.mdx.", "docs/a.md.bak.", "xdocs/a.md.", "docs/a.md/b.md."]) {
        const instruction = `Update docs/cli.md with the flags. Do not change ${form}`;
        expect(admissionNames(instruction, "docs/a.md"), form).toBe(false);
        expect(guard(instruction, pages), form).toEqual([]);
      }
    });

    it("drops the same kept-unchanged pages on both arms", async () => {
      const guard = await knowledgeGuard();
      const pages = ["docs/cli.md", "docs/a.md"];
      const config = stubConfig(await roots.create("docsfab-intent-kept-"));
      for (const [instruction, dropped] of [
        ["Update docs/cli.md with the flags. Leave ./docs/a.md unchanged.", ["docs/a.md"]],
        ["Update docs/cli.md; keep docs/a.md unchanged.", ["docs/a.md"]],
        ["Update docs/cli.md and docs/a.md; keep the examples unchanged.", []],
        [
          "Keep the examples unchanged and update docs/cli.md and docs/a.md with the new flags.",
          [],
        ],
        ["Leave the intro unchanged and update docs/cli.md and docs/a.md.", []],
      ] as const) {
        const noIntent = await bindFirstRunProposalScope({
          request: request("/tmp/repo", "update-documentation", instruction),
          config,
          revision: REVISION,
        });
        const bound = noIntent?.targetPaths ?? [];
        expect(
          pages.filter((page) => !bound.includes(page)),
          instruction,
        ).toEqual(dropped);
        expect(guard(instruction, pages), instruction).toEqual(dropped);
      }
    });
  });

  describe("the narrowing guard is the no-intent parser over the normalized request (row 15, sweep)", () => {
    type Mention = {
      readonly path: string;
      readonly index: number;
      readonly normalized: { readonly start: number; readonly end: number };
      readonly source: { readonly start: number; readonly end: number };
    };
    type ParseModule = {
      nonActionableNamedTargets: (instruction: string, targetPaths: readonly string[]) => string[];
      normalizeNamedPathMentions: (
        instruction: string,
        targetPaths: readonly string[],
      ) => { readonly text: string; readonly mentions: readonly Mention[] };
      parseOrdinaryDocumentationRequest: (input: {
        workflow: string;
        instruction: string;
        revision: string;
      }) => { targetPaths: readonly string[]; dependencyPaths: readonly string[] } | undefined;
    };
    const PAGE = "docs/a.md";
    const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

    const codePoints = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, offset) => String.fromCodePoint(from + offset));
    // Every ASCII punctuation mark and bracket; general punctuation and Unicode
    // quotes; CJK symbols, brackets and punctuation; full-width forms.
    const WRAPPERS = [
      ...codePoints(0x21, 0x7e).filter((character) => !/[A-Za-z0-9]/u.test(character)),
      ...codePoints(0x2000, 0x206f),
      ...codePoints(0x3000, 0x303f),
      ...codePoints(0xff00, 0xff65),
    ];
    const PAIRS = [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
      ["<", ">"],
      ["“", "”"],
      ["‘", "’"],
      ["（", "）"],
      ["［", "］"],
      ["｛", "｝"],
      ["＜", "＞"],
      ["〈", "〉"],
      ["《", "》"],
      ["「", "」"],
      ["『", "』"],
      ["【", "】"],
      ["〔", "〕"],
    ] as const;
    const STRUCTURED = [
      "./docs/a.md",
      "docs/a.md#install",
      "`./docs/a.md#x`",
      "[the page](docs/a.md)",
      '[the page](docs/a.md "Install")',
      "[the page](<./docs/a.md#y> (Install))",
      "Docs/A.MD",
      "./DOCS/a.md#x",
    ];
    const NARROWING = [
      ["negated", (form: string) => `Do not update ${form} at all.`],
      ["deferred, later", (form: string) => `Update ${form} later.`],
      ["deferred, not yet", (form: string) => `Update ${form}, but not yet.`],
      ["kept unchanged", (form: string) => `Update the intro; keep ${form} unchanged.`],
    ] as const;
    const ASKED = [
      ["asked to change", (form: string) => `Update ${form} with the flags.`],
      [
        "asked after a keep clause",
        (form: string) => `Keep the examples unchanged and update ${form} with the new flags.`,
      ],
    ] as const;

    async function parseModule(): Promise<ParseModule> {
      return (await import(
        pathToFileURL(join(knowledgeSource, "first-pass", "parse.mjs")).href
      )) as ParseModule;
    }

    /**
     * Whether admission grounds `PAGE` in the request, in any letter case: named
     * grounding is exact case, and an inventory page meets the case fold.
     */
    function admissionNames(instruction: string): boolean {
      const text = instruction.normalize("NFC");
      const folded = text.toLowerCase();
      expect(folded.length, instruction).toBe(text.length);
      return spanNamesPath(pathTokenText(folded), { start: 0, end: folded.length }, PAGE);
    }

    /** The no-intent parser's verdict on `PAGE` in `text`: narrowed, bound, or not read at all. */
    function parserVerdict(knowledge: ParseModule, text: string): boolean | undefined {
      const parse = (instruction: string) =>
        knowledge.parseOrdinaryDocumentationRequest({
          workflow: "update-documentation",
          instruction,
          revision: REVISION,
        });
      let parsed: ReturnType<ParseModule["parseOrdinaryDocumentationRequest"]>;
      try {
        parsed = parse(text);
      } catch (error) {
        if ((error as { code?: string }).code !== "non-actionable-targets") throw error;
        // The refusal names no page. Beside an actionable page the parser binds
        // the non-actionable ones, which shows whether it read this page at all.
        const beside = parse(`${text} Update docs/zz.md.`);
        return beside?.targetPaths.includes(PAGE) || beside?.dependencyPaths.includes(PAGE)
          ? true
          : undefined;
      }
      if (parsed?.targetPaths.includes(PAGE)) return false;
      if (parsed?.dependencyPaths.includes(PAGE)) return true;
      return undefined;
    }

    /** Text outside the mentions is unchanged, and each mention is the bare page. */
    function expectOnlyMentionsChanged(
      instruction: string,
      normalized: ReturnType<ParseModule["normalizeNamedPathMentions"]>,
    ): void {
      const source = instruction.normalize("NFC");
      let from = 0;
      let to = 0;
      for (const mention of normalized.mentions) {
        expect(normalized.text.slice(to, mention.normalized.start), instruction).toBe(
          source.slice(from, mention.source.start),
        );
        expect(normalized.text.slice(mention.index, mention.index + PAGE.length), instruction).toBe(
          PAGE,
        );
        from = mention.source.end;
        to = mention.normalized.end;
      }
      expect(normalized.text.slice(to), instruction).toBe(source.slice(from));
    }

    it("grounds what admission grounds, never adds a page, and narrows as the parser does", async () => {
      const knowledge = await parseModule();
      const forms = new Set<string>(STRUCTURED);
      for (const character of WRAPPERS) {
        forms.add(`${character}${PAGE}`);
        forms.add(`${PAGE}${character}`);
        forms.add(`${character}${PAGE}${character}`);
      }
      for (const [open, close] of PAIRS) forms.add(`${open}${PAGE}${close}`);
      let compared = 0;
      let instructions = 0;
      let scriptEdges = 0;
      let grounded = 0;
      const unread: string[] = [];
      for (const form of forms) {
        for (const [label, words] of [...NARROWING, ...ASKED]) {
          const instruction = words(form);
          instructions += 1;
          const normalized = knowledge.normalizeNamedPathMentions(instruction, [PAGE]);
          // Both directions: the guard grounds a mention exactly where admission does.
          const named = admissionNames(instruction);
          expect(normalized.mentions.length > 0, `${label}: ${instruction}`).toBe(named);
          if (named) grounded += 1;
          expectOnlyMentionsChanged(instruction, normalized);
          const guarded = knowledge.nonActionableNamedTargets(instruction, [PAGE]);
          expect([[], [PAGE]], `${label}: ${instruction}`).toContainEqual(guarded);
          let text = normalized.text;
          const edge = normalized.mentions.find((mention) =>
            UNSPACED.test(text.slice(mention.normalized.end, mention.normalized.end + 1)),
          );
          if (edge !== undefined) {
            // The parser has no rule for a path run into unspaced script, as in
            // "docs/a.md的"; it reads one where a space marks the edge.
            scriptEdges += 1;
            text = `${text.slice(0, edge.normalized.end)} ${text.slice(edge.normalized.end)}`;
          }
          const verdict = parserVerdict(knowledge, text);
          if (verdict === undefined) {
            unread.push(instruction);
            continue;
          }
          compared += 1;
          expect(guarded.length > 0, `${label}: ${instruction} -> ${text}`).toBe(verdict);
        }
      }
      // The parser reads every page admission grounds once it is normalized.
      expect(unread.filter((instruction) => admissionNames(instruction))).toEqual([]);
      expect(scriptEdges).toBeGreaterThan(0);
      expect(compared, `${compared} of ${instructions} compared`).toBeGreaterThanOrEqual(grounded);
    });

    it("narrows every bracketed, quoted or structured grounded form as it narrows the bare path", async () => {
      const knowledge = await parseModule();
      const forms = [...STRUCTURED, ...PAIRS.map(([open, close]) => `${open}${PAGE}${close}`)];
      for (const quote of ['"', "'", "`", "＂", "＇"]) forms.push(`${quote}${PAGE}${quote}`);
      for (const form of forms) {
        for (const [label, words] of NARROWING) {
          const instruction = `Update docs/cli.md with the flags. ${words(form)}`;
          expect(admissionNames(instruction), `${label}: ${instruction}`).toBe(true);
          expect(
            knowledge.nonActionableNamedTargets(instruction, ["docs/cli.md", PAGE]),
            `${label}: ${instruction}`,
          ).toEqual([PAGE]);
        }
        // The parser's write clause starts at the request's first write
        // operation, so the asked forms stand alone.
        for (const [label, words] of ASKED) {
          const instruction = words(form);
          expect(
            knowledge.nonActionableNamedTargets(instruction, ["docs/cli.md", PAGE]),
            `${label}: ${instruction}`,
          ).toEqual([]);
        }
      }
    });
  });

  describe("the no-intent arm keeps today's binding (rows 8, 12, 13)", () => {
    const scope = async (
      instruction: string,
      workflow: "create-documentation" | "update-documentation",
      requestIntent?: RunRecordRequestIntentV1,
    ) =>
      bindFirstRunProposalScope({
        request: {
          ...request("/tmp/repo", workflow, instruction),
          ...(requestIntent ? { requestIntent } : {}),
        },
        config: stubConfig(await roots.create("docsfab-intent-no-intent-")),
        revision: REVISION,
      });

    it.each(["offline", "not-applicable", "continuation", "absent"] as const)(
      "binds a named create and binds nothing for a path-less one: %s",
      async (outcome) => {
        const recorded = outcome === "absent" ? undefined : notInterpreted(outcome);
        expect(
          (await scope("Create docs/guide.md for operators.", "create-documentation", recorded))
            ?.targetPaths,
        ).toEqual(["docs/guide.md"]);
        expect(
          await scope("Create a get-started page.", "create-documentation", recorded),
        ).toBeUndefined();
      },
    );

    it("never binds a merely mentioned agent file or a read source as a write target", async () => {
      const offline = notInterpreted("offline");
      // Today's binding for this request is a refusal naming the agent file the
      // parser reads as a page; the arm neither drops nor adds a page.
      await expect(
        scope("Update docs/guide.md and acknowledge AGENTS.md.", "update-documentation", offline),
      ).rejects.toMatchObject({ code: "proposal-scope-unsafe-target" });
      expect(
        (await scope("Update docs/a.md using docs/b.md.", "update-documentation", offline))
          ?.targetPaths,
      ).toEqual(["docs/a.md"]);
    });
  });

  describe("the source request projection carries the intent (D7, row 10)", () => {
    const resolved = {
      runId: "run-1826a",
      workspaceIdentitySha256: sha("workspace"),
      repository: { identitySha256: sha("repository"), revision: REVISION },
    };
    const instruction = "Create docs/guide.md for operators.";
    const base = {
      workflow: "create-documentation",
      workspacePath: "/workspace",
      repository: { sourcePath: "/repo", revision: REVISION },
      allowWrite: true,
      instruction,
    };

    it("selects version 3 for a request carrying the intent, and the digest moves with any quote", () => {
      const admitted = recordedIntent(instruction, {
        operation: "create",
        targets: [{ path: "docs/guide.md", quote: "docs/guide.md" }],
      });
      const withIntent = { ...base, requestIntent: admitted };
      expect(selectSourceRequestProjectionVersion(withIntent)).toBe(3);
      expect(selectSourceRequestProjectionVersion({ ...base })).toBe(1);
      const digest = projectSourceRequestContext({ ...withIntent }, resolved);
      expect(digest).toBe(
        computeSourceRequestSha256V3({
          ...resolved,
          workflow: base.workflow,
          task: null,
          contextTarget: null,
          instruction,
          reviewScope: null,
          allowWrite: true,
          releaseDefaultBranch: null,
          taskLineage: null,
          compositionExecution: null,
          knowledgeResumeReceipt: null,
          readerContextInput: null,
          readerTaskContext: null,
          readerContext: null,
          readerContextProvenance: null,
          editorialEvidenceRefs: null,
          requestIntent: admitted,
        }),
      );
      expect(digest).not.toBe(projectSourceRequestContext({ ...base }, resolved));
      const requoted = recordedIntent(instruction, {
        operation: "create",
        targets: [{ path: "docs/guide.md", quote: "for operators" }],
      });
      expect(projectSourceRequestContext({ ...base, requestIntent: requoted }, resolved)).not.toBe(
        digest,
      );
    });

    it(
      "admits a --source binding on the runner for a run with an admitted intent (R1)",
      async () => {
        capture.intercept = false;
        const fixture = await createSourceFixture();
        roots.track(fixture.root);
        const runRequest = sourceRunRequest(fixture, [HTML_SOURCE_PATH]);
        const record = await executeRunRequest(runRequest, runtimeConfig(fixture.stateDirectory), {
          silent: true,
          executionHarness: new SourceToolHarness({
            readOnSkill: "plan-documentation",
            listOnly: false,
            revision: false,
            planSourcePaths: [HTML_SOURCE_PATH],
          }),
          skillResolver,
          requestInterpreter: port({
            operation: "create",
            targets: [{ path: PAGE_PATH, role: "write", chosenFrom: "named", quote: PAGE_PATH }],
          }),
        });
        expect(record?.requestIntent?.admission.outcome).toBe("admitted");
        expect(record?.status).toBe("succeeded");
        expect(record?.sourceCitations?.kind).toBe("docsfab-source-run-citations");
      },
      JOURNEY_MS,
    );
  });

  const SUPPORTED_STATEMENT = "The widget --version command prints the installed version.";
  const VERB_FREE_UPDATE = "Bring docs/a.md and docs/b.md up to date with the implementation.";
  const AUDIENCE_UPDATE = "Update docs/cli.md and docs/about.md for the operator audience.";
  const ABOUT_CREATE = "Create the About page docs/about.md and docs/team.md.";
  const ABOUT_CREATE_ONE = "Create the About page docs/about.md.";

  /**
   * A candidate snapshot as first pass leaves it: a README quotation, which
   * supports no page, and one repository-observed behavior claim.
   */
  function snapshotBody(): KnowledgeAcceptedSnapshotBodyV1 {
    return {
      projectId: "PRJ-001",
      modelVersionId: "MODEL-001",
      streamVersion: 6,
      status: "candidate",
      claims: [
        {
          id: "CL-HEADING",
          kind: "behavior",
          scope: "Example Product",
          statement: `Repository source README.md states: "${inputs.cliName}".`,
          modelState: "candidate",
          evidenceIds: ["SRC-001"],
        },
        {
          id: "CL-VERSION",
          kind: "behavior",
          scope: "CLI",
          statement: SUPPORTED_STATEMENT,
          modelState: "candidate",
          evidenceIds: ["SRC-001"],
        },
      ],
      sources: [{ id: "SRC-001", locator: "readme:README.md" }],
      conflicts: [],
    };
  }

  /** An approved snapshot whose one load-bearing conflict blocks only `docs/about/product.md`. */
  function advisoryConflictBody(): KnowledgeAcceptedSnapshotBodyV1 {
    const body = snapshotBody();
    return {
      ...body,
      status: "approved",
      claims: [
        ...body.claims,
        {
          id: "CL-ABOUT-1",
          kind: "intent",
          scope: "About",
          statement: "The product is designed for operators.",
          modelState: "disputed",
          evidenceIds: ["SRC-001"],
        },
        {
          id: "CL-ABOUT-2",
          kind: "intent",
          scope: "About",
          statement: "The product is designed for developers.",
          modelState: "disputed",
          evidenceIds: ["SRC-001"],
        },
      ],
      conflicts: [
        {
          id: "CF-ABOUT",
          claimIds: ["CL-ABOUT-1", "CL-ABOUT-2"],
          classification: {
            impact: "load-bearing",
            impactBasisSha256: "b".repeat(64),
            blockingDocumentationPaths: ["docs/about/product.md"],
            resolutionOwner: "product-owner",
            authorityKind: "product-decision-owner",
          },
        },
      ],
    };
  }

  const candidateSnapshot = (): KnowledgeAcceptedSnapshotV1 =>
    createKnowledgeAcceptedSnapshot(snapshotBody());

  /** The snapshot committed at the path first pass reuses instead of gathering. */
  function trackedSnapshot(snapshot: KnowledgeAcceptedSnapshotV1 = candidateSnapshot()) {
    return { [FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH]: `${JSON.stringify(snapshot, null, 2)}\n` };
  }

  const trackedCreateIntent = (paths: readonly string[]): IntentSpec => ({
    operation: "create",
    targets: paths.map((path) => ({ path, quote: path })),
  });

  async function bindTrackedControl(
    workflow: "create-documentation" | "update-documentation",
    instruction: string,
    requestIntent: RunRecordRequestIntentV1 | undefined,
    snapshot: KnowledgeAcceptedSnapshotV1 = candidateSnapshot(),
  ) {
    const workspacePath = await roots.create("docsfab-intent-tracked-");
    await mkdir(dirname(join(workspacePath, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH)), {
      recursive: true,
    });
    await writeFile(
      join(workspacePath, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH),
      `${JSON.stringify(snapshot)}\n`,
    );
    return bindFirstPassKnowledge({
      request: {
        ...request(workspacePath, workflow, instruction),
        ...(requestIntent ? { requestIntent } : {}),
      },
      config: stubConfig(await roots.create("docsfab-intent-tracked-state-")),
      workspacePath,
      revision: REVISION,
      status: () => undefined,
    });
  }

  function boundedTemplate(page: string, statement = SUPPORTED_STATEMENT): string {
    return [
      `Write \`${page}\` using only these repository-observed behavior claims:`,
      `- ${statement}`,
    ].join("\n");
  }

  function named(
    paths: readonly string[],
    chosenFrom: "named" | "proposed-new" = "named",
  ): Record<string, unknown>[] {
    return paths.map((path) => ({ path, role: "write", chosenFrom, quote: path }));
  }

  describe("admission on a tracked snapshot reads the admitted intent, through executeRunRequest", {
    timeout: JOURNEY_MS,
  }, () => {
    it("continues a verb-free two-page update the intent admits (row 1)", async () => {
      await countingProvider();
      const { repositoryPath, stateDirectory } = await fixture({
        "docs/a.md": "# A\n",
        "docs/b.md": "# B\n",
        ...trackedSnapshot(),
      });
      const outcome = await run(
        request(repositoryPath, "update-documentation", VERB_FREE_UPDATE),
        stateDirectory,
        port({ operation: "update", targets: named(["docs/b.md", "docs/a.md"]) }),
      );
      // Two admitted pages take first pass, which reuses the tracked snapshot.
      expect(firstPassLog.routes).toEqual([true]);
      expect(firstPassLog.entered).toBe(1);
      expect(outcome.result?.error, "first pass stopped the admitted update").toBeUndefined();
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/a.md", "docs/b.md"]);
      expect(parserCalls(), "an admitted intent reached the request parser").toEqual([]);
      expect(scopeProbeCalls()).toEqual([VERB_FREE_UPDATE]);
      // The no-intent arm still reads these words: no operation word, no page.
      expect(inspectRequestedPageSupport(candidateSnapshot(), VERB_FREE_UPDATE)).toMatchObject({
        disposition: "needs-input",
        stopReason: "insufficient-evidence",
      });
    });

    it.each([
      ["update", AUDIENCE_UPDATE, ["docs/about.md", "docs/cli.md"]],
      ["create", ABOUT_CREATE, ["docs/about.md", "docs/team.md"]],
    ] as const)(
      "continues an admitted %s whose words name an intent-bearing page (row 2)",
      async (operation, instruction, pages) => {
        await countingProvider();
        const { repositoryPath, stateDirectory } = await fixture({
          ...(operation === "update" ? { "docs/about.md": "# About\n" } : {}),
          ...trackedSnapshot(),
        });
        const outcome = await run(
          request(repositoryPath, `${operation}-documentation`, instruction),
          stateDirectory,
          port({
            operation,
            targets: named(pages, operation === "create" ? "proposed-new" : "named"),
          }),
        );
        expect(firstPassLog.routes).toEqual([true]);
        expect(firstPassLog.entered).toBe(1);
        expect(outcome.result?.error, "first pass stopped on the request words").toBeUndefined();
        expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
        expect(controlPaths(captured())).toEqual(pages);
        expect(parserCalls()).toEqual([]);
        // Without an intent the same words stop on this snapshot.
        expect(inspectRequestedPageSupport(candidateSnapshot(), instruction)).toMatchObject({
          disposition: "needs-input",
          stopReason: "insufficient-evidence",
        });
      },
    );

    it("gathers once for one admitted page a tracked candidate does not cover, and continues two (row 2b)", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const single = await fixture(trackedSnapshot());
      const oldDigest = candidateSnapshot().snapshotSha256;
      const continuedSingle = await run(
        request(single.repositoryPath, "create-documentation", ABOUT_CREATE_ONE),
        single.stateDirectory,
        port({ operation: "create", targets: named(["docs/about.md"], "proposed-new") }),
      );
      expect(firstPassLog.entered).toBe(1);
      expect(globalThis.__docsfabGatherCalls).toBe(1);
      expect(continuedSingle.result?.error).toBeUndefined();
      expect((continuedSingle.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(controlPaths(captured())).toEqual(["docs/about.md"]);
      expect(captured().firstPassNotices).toContainEqual(expect.stringContaining(oldDigest));

      capture.invocations.length = 0;
      const pair = await fixture(trackedSnapshot());
      const continued = await run(
        request(pair.repositoryPath, "create-documentation", ABOUT_CREATE),
        pair.stateDirectory,
        port({
          operation: "create",
          targets: named(["docs/about.md", "docs/team.md"], "proposed-new"),
        }),
      );
      expect(firstPassLog.entered).toBe(2);
      expect(globalThis.__docsfabGatherCalls).toBe(1);
      expect(continued.result?.error).toBeUndefined();
      expect((continued.error as Error).message).toBe(STOP_AT_EXECUTION);
    });

    it("gathers for a pathless admitted create and a bounded-statement shortfall", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const pathless = await fixture(trackedSnapshot());
      const create = await run(
        request(pathless.repositoryPath, "create-documentation", CREATE_CLI_CONFIGURATION),
        pathless.stateDirectory,
        port({
          operation: "create",
          targets: [
            {
              path: "docs/cli-configuration.md",
              role: "write",
              chosenFrom: "proposed-new",
              quote: "configuration guide",
            },
          ],
        }),
      );
      expect(create.result?.error).toBeUndefined();
      expect(create.error).toMatchObject({ message: STOP_AT_EXECUTION });
      expect(globalThis.__docsfabGatherCalls).toBe(1);
      expect(controlPaths(captured())).toEqual(["docs/cli-configuration.md"]);
      expect(parserCalls()).toEqual([]);

      capture.invocations.length = 0;
      const shortfall = await fixture(trackedSnapshot());
      const instruction = boundedTemplate(
        "docs/get-started.md",
        "The product is designed for operators.",
      );
      const bounded = await run(
        request(shortfall.repositoryPath, "create-documentation", instruction),
        shortfall.stateDirectory,
        port({ operation: "create", targets: named(["docs/get-started.md"], "proposed-new") }),
      );
      expect(bounded.result?.error).toBeUndefined();
      expect(bounded.error).toMatchObject({ message: STOP_AT_EXECUTION });
      expect(globalThis.__docsfabGatherCalls).toBe(2);
      expect(controlPaths(captured())).toEqual(["docs/get-started.md"]);
    });

    it("does not gather for approved, offline, conflict, or unresolved-claim snapshots", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      const approved = createKnowledgeAcceptedSnapshot({ ...snapshotBody(), status: "approved" });
      expect(
        await bindTrackedControl(
          "create-documentation",
          ABOUT_CREATE_ONE,
          recordedIntent(ABOUT_CREATE_ONE, trackedCreateIntent(["docs/about.md"])),
          approved,
        ),
      ).toMatchObject({ completed: true });
      expect(globalThis.__docsfabGatherCalls).toBe(0);

      await expect(
        bindTrackedControl("create-documentation", ABOUT_CREATE_ONE, notInterpreted("offline")),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "insufficient-evidence" });
      expect(globalThis.__docsfabGatherCalls).toBe(0);

      const conflicted = createKnowledgeAcceptedSnapshot(advisoryConflictBody());
      const conflictingInstruction = boundedTemplate("docs/about/product.md");
      await expect(
        bindTrackedControl(
          "create-documentation",
          conflictingInstruction,
          recordedIntent(conflictingInstruction, trackedCreateIntent(["docs/about/product.md"])),
          conflicted,
        ),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "conflict" });
      expect(globalThis.__docsfabGatherCalls).toBe(0);

      const body = snapshotBody();
      const unresolved = createKnowledgeAcceptedSnapshot({
        ...body,
        claims: body.claims.map((claim) =>
          claim.id === "CL-VERSION" ? { ...claim, modelState: "unresolved" as const } : claim,
        ),
      });
      await expect(
        bindTrackedControl(
          "create-documentation",
          ABOUT_CREATE_ONE,
          recordedIntent(ABOUT_CREATE_ONE, trackedCreateIntent(["docs/about.md"])),
          unresolved,
        ),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "unresolved-claim" });
      expect(globalThis.__docsfabGatherCalls).toBe(0);
    });

    it("keeps the superseded digest on a retained authorization stop and no warning on an unrelated stop", async () => {
      await countingProvider();
      bridgeHolder.bridge = scriptedSupportBridge();
      globalThis.__docsfabAuthorizationStop = true;
      const oldDigest = candidateSnapshot().snapshotSha256;
      const stopped = await fixture(trackedSnapshot());
      const authorization = await run(
        request(stopped.repositoryPath, "create-documentation", ABOUT_CREATE_ONE),
        stopped.stateDirectory,
        port({ operation: "create", targets: named(["docs/about.md"], "proposed-new") }),
      );
      expect(
        authorization.error,
        authorization.error instanceof Error
          ? `${String((authorization.error as { code?: unknown }).code)}\n${authorization.error.stack}`
          : "authorization stop returned an unknown error",
      ).toBeUndefined();
      expect(authorization.result).toMatchObject({
        status: "needs-input",
        error: "needs-authorization",
      });
      expect(globalThis.__docsfabGatherCalls).toBe(1);
      expect(authorization.result?.evidenceWarnings).toContainEqual(
        expect.stringContaining(oldDigest),
      );

      const body = snapshotBody();
      const unresolved = createKnowledgeAcceptedSnapshot({
        ...body,
        claims: body.claims.map((claim) =>
          claim.id === "CL-VERSION" ? { ...claim, modelState: "unresolved" as const } : claim,
        ),
      });
      const control = await fixture(trackedSnapshot(unresolved));
      const unrelated = await run(
        request(control.repositoryPath, "create-documentation", ABOUT_CREATE_ONE),
        control.stateDirectory,
        port({ operation: "create", targets: named(["docs/about.md"], "proposed-new") }),
      );
      expect(unrelated.error).toBeUndefined();
      expect(unrelated.result).toMatchObject({ status: "needs-input", error: "unresolved-claim" });
      expect(unrelated.result?.evidenceWarnings).toBeUndefined();
      expect(globalThis.__docsfabGatherCalls).toBe(1);
    });

    it("keeps the planner route for one admitted page of either pilot update, and first pass for two (T3b)", async () => {
      await countingProvider();
      // Supports a first pass if the route ever took one, so no provider is called.
      bridgeHolder.bridge = scriptedSupportBridge();
      const cases = [
        {
          instruction: UPDATE_CLI_REFERENCE,
          first: { path: "docs/cli.md", quote: "the CLI reference" },
          second: { path: "docs/configuration.md", quote: "the current configure flags" },
        },
        {
          instruction: UPDATE_TELEMETRY_CONFIGURATION,
          first: { path: "docs/configuration.md", quote: "the configuration page" },
          second: { path: "docs/troubleshooting.md", quote: "the existing troubleshooting advice" },
        },
      ];
      const files = {
        "docs/configuration.md": "# Configuration\n\nThe sampling interval is 30 seconds.\n",
        "docs/troubleshooting.md": "# Troubleshooting\n\nCheck the endpoint.\n",
        ...trackedSnapshot(),
      };
      for (const { instruction, first, second } of cases) {
        const target = (entry: { path: string; quote: string }) => ({
          ...entry,
          role: "write",
          chosenFrom: "inventory",
        });
        firstPassLog.routes.length = 0;
        firstPassLog.entered = 0;
        globalThis.__docsfabProviderParserCalls = [];
        const one = await fixture(files);
        await run(
          request(one.repositoryPath, "update-documentation", instruction),
          one.stateDirectory,
          port({ operation: "update", targets: [target(first)] }),
        );
        expect(firstPassLog.routes, instruction).toEqual([false]);
        expect(firstPassLog.entered, instruction).toBe(0);

        firstPassLog.routes.length = 0;
        const two = await fixture(files);
        const outcome = await run(
          request(two.repositoryPath, "update-documentation", instruction),
          two.stateDirectory,
          port({ operation: "update", targets: [target(first), target(second)] }),
        );
        expect(firstPassLog.routes, instruction).toEqual([true]);
        expect(firstPassLog.entered, instruction).toBe(1);
        expect(outcome.result?.error, instruction).toBeUndefined();
        expect(parserCalls(), instruction).toEqual([]);

        // The no-intent arm's route for the same words is today's planner route.
        expect(
          await needsFirstPassKnowledgeForExecution(
            request(one.repositoryPath, "update-documentation", instruction),
            { schemaVersion: 2 },
            undefined,
            { config: stubConfig(one.stateDirectory), revision: REVISION },
          ),
          instruction,
        ).toBe(false);
      }
    });

    it("binds exactly the admitted pages past a scope restriction, without the request parser (row 4)", async () => {
      await countingProvider();
      const instruction =
        "Bring docs/a.md and docs/b.md up to date. Only update docs/a.md and docs/b.md.";
      const { repositoryPath, stateDirectory } = await fixture({
        "docs/a.md": "# A\n",
        "docs/b.md": "# B\n",
        ...trackedSnapshot(),
      });
      const outcome = await run(
        request(repositoryPath, "update-documentation", instruction),
        stateDirectory,
        port({ operation: "update", targets: named(["docs/a.md", "docs/b.md"]) }),
      );
      expect(outcome.result?.error).toBeUndefined();
      expect(controlPaths(captured())).toEqual(["docs/a.md", "docs/b.md"]);
      // The scope-restriction reading lives only inside the request parser.
      expect(parserCalls()).toEqual([]);
    });

    async function canonSnapshotRun(
      instruction: string,
      interpreter: ReturnType<typeof port>,
    ): Promise<{ result?: RunRecord; error?: unknown }> {
      const { repositoryPath, stateDirectory } = await fixture();
      const snapshotPath = join(
        await roots.create("docsfab-intent-canon-snapshot-"),
        "snapshot.json",
      );
      await writeFile(snapshotPath, JSON.stringify(candidateSnapshot()));
      return await run(
        {
          ...request(repositoryPath, "create-documentation", instruction),
          canonSnapshotPath: snapshotPath,
          acceptCandidateSnapshot: true,
          canonSnapshotAuthorityId: "operator-test",
        } as RunRequestWithPublishProjection,
        stateDirectory,
        interpreter,
      );
    }

    it("binds the admitted pages for --canon-snapshot, not the request words (CS1)", async () => {
      await countingProvider();
      const interpreter = port({
        operation: "create",
        targets: named(["docs/about.md", "docs/team.md"], "proposed-new"),
      });
      const outcome = await canonSnapshotRun(ABOUT_CREATE, interpreter);
      // The import counts the two admitted pages; the About words, which stop a
      // candidate on the no-intent arm, are not read.
      expect(interpreter.calls).toHaveLength(1);
      expect(firstPassLog.entered).toBe(0);
      expect(outcome.error).toMatchObject({ message: STOP_AT_EXECUTION });
      const invocation = captured();
      expect(invocation.request.requestIntent?.admission.outcome).toBe("admitted");
      // A fresh run reads its own admission; only a continuation carries pages.
      expect(invocation.continuationPageIntent).toBeUndefined();
      expect(parserCalls()).toEqual([]);
    });

    it("keeps today's stop for an advisory --canon-snapshot reading that carries pages (CSA)", async () => {
      await countingProvider();
      // Another operation than the declared create: an advisory, which binds nothing.
      const interpreter = port({
        operation: "update",
        targets: named(["docs/about.md", "docs/team.md"]),
      });
      const outcome = await canonSnapshotRun(ABOUT_CREATE, interpreter);
      expect(interpreter.calls).toHaveLength(1);
      expect(capture.invocations).toHaveLength(0);
      expect(outcome.error).toMatchObject({
        name: "KnowledgeResumeError",
        code: "insufficient-evidence",
      });
    });

    // Residue for #2057 and the fresh-support gather: one admitted page is not a
    // multi-page request, and a candidate supports no single page by itself.
    it("still stops one admitted page on a candidate --canon-snapshot (one-page row)", async () => {
      await countingProvider();
      const interpreter = port({
        operation: "create",
        targets: named(["docs/about.md"], "proposed-new"),
      });
      const outcome = await canonSnapshotRun(ABOUT_CREATE_ONE, interpreter);
      expect(interpreter.calls).toHaveLength(1);
      expect(outcome.error).toMatchObject({
        name: "KnowledgeResumeError",
        code: "insufficient-evidence",
      });
    });
  });

  describe("an admitted reading with no write target (CSZ, Z1)", () => {
    // Admission turns a reading that names no page into an advisory or a
    // question, so these records reach the host only as recorded fixtures.
    const UPDATE_ABOUT = "Update the About page docs/about.md for the operator audience.";
    const zeroTargets = (instruction: string) =>
      recordedIntent(instruction, { operation: "update", targets: [] });

    async function canonSnapshotAssembly(requestIntent?: RunRecordRequestIntentV1) {
      const workspacePath = await roots.create("docsfab-intent-zero-target-");
      const snapshotPath = join(workspacePath, "snapshot.json");
      await writeFile(snapshotPath, JSON.stringify(candidateSnapshot()));
      return await assembleHostOperations(
        {
          request: {
            ...request(workspacePath, "update-documentation", UPDATE_ABOUT),
            canonSnapshotPath: snapshotPath,
            acceptCandidateSnapshot: true,
            canonSnapshotAuthorityId: "operator-test",
            ...(requestIntent ? { requestIntent } : {}),
          } as RunRequestWithPublishProjection,
          config: stubConfig(await roots.create("docsfab-intent-zero-target-state-")),
          options: {},
          output: { log: () => undefined, error: () => undefined },
        },
        { path: workspacePath, sourcePath: workspacePath, revision: REVISION } as never,
        {} as never,
        {} as never,
      );
    }

    it("keeps the path-less continue for --canon-snapshot on a candidate (CSZ)", async () => {
      await countingProvider();
      const assembly = await canonSnapshotAssembly(zeroTargets(UPDATE_ABOUT));
      expect(assembly.task).toMatchObject({ kind: "update-documentation" });
      expect(assembly.knowledgeResumeReceipt).toBeUndefined();
      expect(parserCalls()).toEqual([]);
      // The same words without an intent stop the candidate on the About page.
      await expect(canonSnapshotAssembly()).rejects.toMatchObject({
        name: "KnowledgeResumeError",
        code: "insufficient-evidence",
      });
    });

    it("keeps an update with no admitted page off first pass, without the parser (Z1)", async () => {
      await countingProvider();
      const state = await roots.create("docsfab-intent-zero-target-route-");
      const route = (requestIntent?: RunRecordRequestIntentV1) =>
        needsFirstPassKnowledgeForExecution(
          {
            ...request(state, "update-documentation", UPDATE_ABOUT),
            ...(requestIntent ? { requestIntent } : {}),
          },
          { schemaVersion: 2 },
          undefined,
          { config: stubConfig(state), revision: REVISION },
        );
      expect(await route(zeroTargets(UPDATE_ABOUT))).toBe(false);
      expect(parserCalls()).toEqual([]);
      // Without an intent the parser reads the words, which name a page.
      expect(await route()).toBe(true);
      expect(parserCalls()).toEqual([UPDATE_ABOUT]);
    });
  });

  describe("admission on a tracked snapshot, at bindFirstPassKnowledge (rows 2c, 6; A1)", () => {
    const bindTracked = bindTrackedControl;
    const createIntent = trackedCreateIntent;

    it("scopes an advisory conflict to the admitted page, never the template header's (row 2c)", async () => {
      const conflicted = createKnowledgeAcceptedSnapshot(advisoryConflictBody());
      // The header names the blocked page; the intent admits another.
      const instruction = boundedTemplate("docs/about/product.md");
      const admittedOther = recordedIntent(instruction, {
        operation: "create",
        targets: [{ path: "docs/reference/cli.mdx", quote: "docs/about/product.md" }],
      });
      const binding = await bindTracked(
        "create-documentation",
        instruction,
        admittedOther,
        conflicted,
      );
      expect(binding?.knowledgeResumeReceipt).toMatchObject({
        selectedTargetPath: "docs/reference/cli.mdx",
        advisoryConflicts: [
          { conflictId: "CF-ABOUT", blockingDocumentationPaths: ["docs/about/product.md"] },
        ],
      });
      // Offline, the header still picks the page, and that page is blocked.
      await expect(
        bindTracked("create-documentation", instruction, notInterpreted("offline"), conflicted),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "conflict" });

      // The reverse: the intent admits the blocked page under a header naming another.
      const otherHeader = boundedTemplate("docs/reference/cli.mdx");
      await expect(
        bindTracked(
          "create-documentation",
          otherHeader,
          recordedIntent(otherHeader, {
            operation: "create",
            targets: [{ path: "docs/about/product.md", quote: "docs/reference/cli.mdx" }],
          }),
          conflicted,
        ),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "conflict" });
      // Two admitted pages select none, so any conflict blocks, as with no page.
      await expect(
        bindTracked(
          "create-documentation",
          otherHeader,
          recordedIntent(otherHeader, {
            operation: "create",
            targets: [
              { path: "docs/reference/cli.mdx", quote: "docs/reference/cli.mdx" },
              { path: "docs/reference/more.mdx", quote: "docs/reference/cli.mdx" },
            ],
          }),
          conflicted,
        ),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "conflict" });
    });

    it("keeps statement coverage for a bounded template under an intent (row 6)", async () => {
      const page = "docs/get-started.md";
      const supported = boundedTemplate(page);
      expect(
        await bindTracked(
          "create-documentation",
          supported,
          recordedIntent(supported, createIntent([page])),
        ),
      ).toEqual({ completed: true });
      const unsupported = boundedTemplate(page, "The product is designed for operators.");
      expect(
        inspectRequestedPageSupport(candidateSnapshot(), unsupported, { writeTargets: [page] }),
      ).toMatchObject({
        disposition: "needs-input",
        stopReason: "insufficient-evidence",
      });
      // Offline the template keeps today's result, and so does the About request.
      expect(
        await bindTracked("create-documentation", supported, notInterpreted("offline")),
      ).toEqual({
        completed: true,
      });
      await expect(
        bindTracked(
          "create-documentation",
          "Create an About page that states the product purpose.",
          notInterpreted("offline"),
        ),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "insufficient-evidence" });
    });

    it("reads the request words for an advisory reading that carries pages (A1)", async () => {
      const advisory = advisoryIntent(
        VERB_FREE_UPDATE,
        {
          operation: "update",
          targets: [
            { path: "docs/a.md", quote: "docs/a.md" },
            { path: "docs/b.md", quote: "docs/b.md" },
          ],
        },
        "request-intent-operation-mismatch",
      );
      await expect(
        bindTracked("update-documentation", VERB_FREE_UPDATE, advisory),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "insufficient-evidence" });
      // The same reading admitted continues.
      expect(
        await bindTracked(
          "update-documentation",
          VERB_FREE_UPDATE,
          recordedIntent(VERB_FREE_UPDATE, {
            operation: "update",
            targets: [
              { path: "docs/a.md", quote: "docs/a.md" },
              { path: "docs/b.md", quote: "docs/b.md" },
            ],
          }),
        ),
      ).toEqual({ completed: true });
    });
  });

  describe("inspectRequestedPageSupport with and without an admitted intent (rows 2b, 2c, 9)", () => {
    const candidate = candidateSnapshot();
    const pages = (...writeTargets: string[]) => ({ writeTargets });

    it("counts the admitted pages, not the worded ones, on a candidate snapshot", () => {
      // Words that name one page after an operation, with two admitted pages.
      expect(
        inspectRequestedPageSupport(
          candidate,
          "Create docs/a.md.",
          pages("docs/a.md", "docs/b.md"),
        ),
      ).toMatchObject({ disposition: "continue" });
      expect(inspectRequestedPageSupport(candidate, "Create docs/a.md.")).toMatchObject({
        disposition: "needs-input",
        stopReason: "insufficient-evidence",
      });
      // Words that name two pages, with one admitted page.
      const twoWorded = "Create docs/a.md and docs/b.md.";
      expect(inspectRequestedPageSupport(candidate, twoWorded, pages("docs/a.md"))).toMatchObject({
        disposition: "needs-input",
        stopReason: "insufficient-evidence",
      });
      expect(inspectRequestedPageSupport(candidate, twoWorded)).toMatchObject({
        disposition: "continue",
      });
    });

    it("does not take the path-less continue for an admitted page: the intent named it", () => {
      // Without an intent a request naming no page leaves the page to the
      // planner. An admitted intent names one, which a candidate snapshot does
      // not support alone, the same as one worded page. One that names none
      // selects none, so it keeps the path-less continue without reading words.
      expect(inspectRequestedPageSupport(candidate, CREATE_CLI_CONFIGURATION)).toMatchObject({
        disposition: "continue",
      });
      expect(
        inspectRequestedPageSupport(
          candidate,
          CREATE_CLI_CONFIGURATION,
          pages("docs/cli-configuration.md"),
        ),
      ).toMatchObject({ disposition: "needs-input", stopReason: "insufficient-evidence" });
      expect(inspectRequestedPageSupport(candidate, ABOUT_CREATE, pages())).toMatchObject({
        disposition: "continue",
      });
      expect(inspectRequestedPageSupport(candidate, ABOUT_CREATE)).toMatchObject({
        disposition: "needs-input",
        stopReason: "insufficient-evidence",
      });
    });

    it("keeps an approved snapshot's continue and a blocking conflict's stop on both arms", () => {
      const approved = createKnowledgeAcceptedSnapshot({ ...snapshotBody(), status: "approved" });
      for (const intent of [undefined, pages("docs/about.md")]) {
        expect(
          inspectRequestedPageSupport(approved, ABOUT_CREATE_ONE, intent),
          JSON.stringify(intent),
        ).toMatchObject({ disposition: "continue" });
      }
      const conflicted = createKnowledgeAcceptedSnapshot(advisoryConflictBody());
      expect(
        inspectRequestedPageSupport(conflicted, VERB_FREE_UPDATE, pages("docs/about/product.md")),
      ).toMatchObject({ disposition: "needs-input", stopReason: "conflict" });
      // A conflict that does not block the one admitted page leaves a receipt
      // scoped to it; without bounded statements one page is still not covered.
      expect(
        inspectRequestedPageSupport(conflicted, VERB_FREE_UPDATE, pages("docs/a.md")),
      ).toMatchObject({
        disposition: "needs-input",
        stopReason: "insufficient-evidence",
        receipt: { selectedTargetPath: "docs/a.md" },
      });
      // Without an intent these words select no page, so the conflict blocks.
      expect(inspectRequestedPageSupport(conflicted, VERB_FREE_UPDATE)).toMatchObject({
        disposition: "needs-input",
        stopReason: "conflict",
      });
    });
  });
}
