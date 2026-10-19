// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request interpretation in isolation: re-ask bound, stop arms, the three
 * catch conditions, the prompt inventory and its limits, and host
 * verb-independence (#1825). Offline stub ports only.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { limit, OperationalLimitError } from "../src/config/limits.js";
import { WORKFLOW_CANCELLED } from "../src/execution/cancellation.js";
import { estimateModelRequestTokens } from "../src/model/context-budget.js";
import {
  isRequestIntentOffline,
  requestIntentContinuationReason,
  requestIntentDeadlineMs,
  runRequestInterpretation,
} from "../src/cli/run/request-intent-stop.js";
import type { CompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import { RequestIntentContractError } from "../src/request-intent/kit.js";
import {
  buildRequestIntentPromptInventory,
  clipTitle,
  pageTitle,
  resolvePromptInventoryLimits,
  type RequestIntentInventoryLimits,
  type RequestIntentPromptInventory,
} from "../src/request-intent/interpret-inventory.js";
import {
  declaredRequestIntentOperation,
  firstJsonObject,
  interpretRequest,
  REQUEST_INTENT_SYSTEM_PROMPT,
  renderRequestIntentPrompt,
  RequestIntentInputBudgetError,
  RequestIntentModelUnavailableError,
  type InterpretRequestInput,
  type RequestIntentInterpreterCall,
  type RequestIntentInterpreterPort,
} from "../src/request-intent/interpret.js";
import { createRequestIntentModelPort } from "../src/request-intent/interpret-model.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import { validModelConfig } from "./helpers.js";
import { resolveRequestIntentLimits } from "../src/request-intent/limits.js";
import { requestIntentWriteSet } from "../src/request-intent/seal.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = ["README.md", "docs/a.md", "docs/b.md", "docs/cli.md"];
const EMPTY_PROMPT_INVENTORY: RequestIntentPromptInventory = { entries: [], clippedTitles: 0 };
const WIDE_WINDOW = { maxInputTokens: 128_000, maxOutputTokens: 8_192 };
const USAGE = { inputTokens: 10, outputTokens: 5 };
const DOCS_ROOTS = [
  { kind: "root", path: "docs" },
  { kind: "root", path: "fern" },
] as const;
/** Every inventory path is the one exact-case tracked file it names; anything else is absent. */
const INVENTORY_EXISTENCE: InterpretRequestInput["existence"] = async (paths) =>
  paths
    .filter((path) => INVENTORY.includes(path))
    .map((path) => ({ path, existing: "file" as const, base: { sha256: "a".repeat(64) } }));

function proposal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "update",
    targets: [{ path: "docs/cli.md", role: "write", chosenFrom: "named", quote: "docs/cli.md" }],
    authorityPreference: { preference: "unspecified", quote: null },
    ...extra,
  };
}

/** A port replying with each scripted reply in turn, recording every call. */
function scriptedPort(replies: readonly (string | Error)[]): RequestIntentInterpreterPort & {
  readonly calls: RequestIntentInterpreterCall[];
} {
  const calls: RequestIntentInterpreterCall[] = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return { text: reply, usage: USAGE };
    },
  };
}

function input(
  port: RequestIntentInterpreterPort,
  overrides: Partial<InterpretRequestInput> = {},
): InterpretRequestInput {
  return {
    port,
    workflow: "update-documentation",
    operation: "update",
    instruction: "Update docs/cli.md with the new --profile flag.",
    promptInventory: EMPTY_PROMPT_INVENTORY,
    admissionInventory: INVENTORY,
    documentationRoots: DOCS_ROOTS,
    writeRoots: DOCS_ROOTS,
    navigationSet: [],
    existence: INVENTORY_EXISTENCE,
    limits: resolveRequestIntentLimits(),
    maxRetries: 2,
    window: WIDE_WINDOW,
    deadlineMs: limit("requestIntent.interpretationTimeoutMs").value,
    ...overrides,
  };
}

describe("interpretRequest re-asks and stop arms", () => {
  it("asks for a create destination when a path is named only as source evidence", async () => {
    const source = "documentation/tensorrt/getting-started/index.rst";
    const port = scriptedPort([
      JSON.stringify({
        operation: "create",
        targets: [],
        sources: [{ path: source, quote: source }],
        authorityPreference: { preference: "unspecified", quote: null },
      }),
    ]);
    const outcome = await interpretRequest(
      input(port, {
        workflow: "create-documentation",
        operation: "create",
        instruction: `Create a new prerequisites page using ${source} only as source evidence.`,
        admissionInventory: [source],
        documentationRoots: [{ kind: "root", path: "documentation" }],
        writeRoots: [{ kind: "root", path: "documentation" }],
        existence: async () => [],
      }),
    );
    expect(outcome).toMatchObject({ outcome: "question", code: "request-intent-target-missing" });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.prompt).toContain("source evidence is not a write destination");
  });

  it("admits a valid first reply in one call (positive control)", async () => {
    const port = scriptedPort([JSON.stringify(proposal())]);
    const outcome = await interpretRequest(input(port));
    expect(outcome.outcome).toBe("admitted");
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(outcome.calls[0]!.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("resolves a pathless review target only through its exact host inventory entry", async () => {
    const instruction =
      "Review the API reference for technical accuracy and reader usability. Report concrete, " +
      "source-grounded findings with severity and locations, and do not edit the repository.";
    const inventory = ["docs/api.md"];
    const port = scriptedPort([
      JSON.stringify(
        proposal({
          operation: "review",
          targets: [
            {
              path: "docs/api.md",
              role: "write",
              chosenFrom: "inventory",
              quote: "API reference",
            },
          ],
        }),
      ),
    ]);
    const outcome = await interpretRequest(
      input(port, {
        workflow: "review-documentation",
        operation: "review",
        instruction,
        admissionInventory: inventory,
        promptInventory: {
          entries: [{ path: "docs/api.md", title: "HTTP API", navLabel: null }],
          clippedTitles: 0,
        },
        existence: async (paths) =>
          paths.map((path) => ({
            path,
            existing: "file" as const,
            base: { sha256: "a".repeat(64) },
          })),
      }),
    );
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome !== "admitted") return;
    expect(outcome.intent.targets).toMatchObject([
      { path: "docs/api.md", chosenFrom: "inventory", quote: { text: "API reference" } },
    ]);
    expect(port.calls[0]!.prompt).toContain("identifies a page by title or description");
    expect(port.calls[0]!.prompt).toContain("ask a question instead of guessing");

    const correctionPort = scriptedPort([
      JSON.stringify(
        proposal({
          operation: "review",
          targets: [
            {
              path: "docs/api.md",
              role: "write",
              chosenFrom: "named",
              quote: "API reference",
            },
          ],
        }),
      ),
      JSON.stringify(
        proposal({
          operation: "review",
          targets: [
            {
              path: "docs/api.md",
              role: "write",
              chosenFrom: "inventory",
              quote: "API reference",
            },
          ],
        }),
      ),
    ]);
    const corrected = await interpretRequest(
      input(correctionPort, {
        workflow: "review-documentation",
        operation: "review",
        instruction,
        admissionInventory: inventory,
        promptInventory: {
          entries: [{ path: "docs/api.md", title: "HTTP API", navLabel: null }],
          clippedTitles: 0,
        },
        existence: async (paths) =>
          paths.map((path) => ({
            path,
            existing: "file" as const,
            base: { sha256: "a".repeat(64) },
          })),
      }),
    );
    expect(corrected.outcome).toBe("admitted");
    expect(correctionPort.calls).toHaveLength(2);
    const correctionFeedback = correctionPort.calls[1]!.prompt.slice(
      correctionPort.calls[0]!.prompt.length,
    );
    expect(correctionFeedback).toContain("Correction (request-intent-named-ungrounded");
    expect(correctionFeedback).toContain("exact matching path from the host inventory");

    const namedPort = scriptedPort([
      JSON.stringify(
        proposal({
          operation: "review",
          targets: [
            {
              path: "docs/api.md",
              role: "write",
              chosenFrom: "named",
              quote: "API reference",
            },
          ],
        }),
      ),
    ]);
    const named = await interpretRequest(
      input(namedPort, {
        workflow: "review-documentation",
        operation: "review",
        instruction,
        admissionInventory: inventory,
        promptInventory: {
          entries: [{ path: "docs/api.md", title: "HTTP API", navLabel: null }],
          clippedTitles: 0,
        },
        existence: async (paths) =>
          paths.map((path) => ({
            path,
            existing: "file" as const,
            base: { sha256: "a".repeat(64) },
          })),
        maxRetries: 0,
      }),
    );
    expect(named).toMatchObject({ outcome: "rejected", code: "request-intent-named-ungrounded" });

    const inventedPort = scriptedPort([
      JSON.stringify(
        proposal({
          operation: "review",
          targets: [
            {
              path: "docs/invented-api.md",
              role: "write",
              chosenFrom: "inventory",
              quote: "API reference",
            },
          ],
        }),
      ),
    ]);
    const invented = await interpretRequest(
      input(inventedPort, {
        workflow: "review-documentation",
        operation: "review",
        instruction,
        admissionInventory: inventory,
        promptInventory: {
          entries: [{ path: "docs/api.md", title: "HTTP API", navLabel: null }],
          clippedTitles: 0,
        },
        existence: async (paths) =>
          paths.map((path) => ({
            path,
            existing: "file" as const,
            base: { sha256: "a".repeat(64) },
          })),
        maxRetries: 0,
      }),
    );
    expect(invented).toMatchObject({
      outcome: "rejected",
      code: "request-intent-inventory-unmatched",
    });
  });

  it("re-asks a rejection with the catalog hint and admits on call 2", async () => {
    const port = scriptedPort([
      JSON.stringify(proposal({ kind: "docsfab-request-intent" })),
      JSON.stringify(proposal()),
    ]);
    const outcome = await interpretRequest(input(port));
    expect(outcome.outcome).toBe("admitted");
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1]!.prompt.startsWith(port.calls[0]!.prompt)).toBe(true);
    expect(port.calls[1]!.prompt.slice(port.calls[0]!.prompt.length)).toMatch(
      /^\nCorrection \(request-intent-host-field at \$\): Do not write kind/u,
    );
  });

  it("re-asks a non-JSON reply under the shape code", async () => {
    const port = scriptedPort(["Sure! I will update the page.", JSON.stringify(proposal())]);
    const outcome = await interpretRequest(input(port));
    expect(outcome.outcome).toBe("admitted");
    expect(port.calls[1]!.prompt).toContain("Correction (request-intent-shape at $)");
  });

  it.each([0, 1, 3])(
    "stops rejected after exactly 1 + %i calls with the last rejection code",
    async (maxRetries) => {
      const port = scriptedPort([
        ...Array.from({ length: maxRetries }, () => JSON.stringify(proposal({ extra: true }))),
        JSON.stringify(
          proposal({
            targets: [
              { path: "/abs.md", role: "write", chosenFrom: "named", quote: "docs/cli.md" },
            ],
          }),
        ),
      ]);
      const outcome = await interpretRequest(input(port, { maxRetries }));
      expect(outcome).toMatchObject({ outcome: "rejected", code: "request-intent-path-grammar" });
      expect(port.calls).toHaveLength(maxRetries + 1);
      expect(outcome.calls).toHaveLength(maxRetries + 1);
    },
  );

  it("records the last code when the replies change between re-asks", async () => {
    const port = scriptedPort([
      JSON.stringify(proposal({ extra: true })),
      JSON.stringify(proposal({ extra: true })),
      "not json",
    ]);
    const outcome = await interpretRequest(input(port, { maxRetries: 2 }));
    expect(outcome).toMatchObject({ outcome: "rejected", code: "request-intent-shape", at: "$" });
    expect(port.calls).toHaveLength(3);
  });

  it("returns the model's question as an advisory, never admitted and never asked", async () => {
    const question = {
      question: "Which flag should the page document?",
      options: ["--profile", "--config"],
      recommendedDefault: "--profile",
      consequence: "The page documents --profile only.",
    };
    const port = scriptedPort([JSON.stringify(proposal({ questions: [question] }))]);
    const outcome = await interpretRequest(input(port));
    expect(outcome).toMatchObject({
      outcome: "advisory",
      code: "request-intent-model-question",
      at: "$.questions[0]",
    });
    expect(outcome.outcome === "advisory" && outcome.intent.question).toEqual(question);
    expect(port.calls).toHaveLength(1);
  });

  it("refuses an internal path with its boundary and asks no question", async () => {
    const port = scriptedPort([
      JSON.stringify(
        proposal({
          targets: [
            { path: ".git/config", role: "write", chosenFrom: "named", quote: ".git/config" },
          ],
          questions: [
            {
              question: "Proceed?",
              options: ["yes"],
              recommendedDefault: "yes",
              consequence: "It writes.",
            },
          ],
        }),
      ),
    ]);
    const outcome = await interpretRequest(
      input(port, { instruction: "Update .git/config with the new remote." }),
    );
    expect(outcome).toMatchObject({
      outcome: "refused",
      code: "request-intent-internal-path",
      at: "$.targets[0].path",
      boundary: { kind: "internal-segment", segment: ".git", observed: ".git/config" },
    });
    expect(port.calls).toHaveLength(1);
  });

  it("maps only a port-reported provider failure to unavailable", async () => {
    const port = scriptedPort([new RequestIntentModelUnavailableError()]);
    const outcome = await interpretRequest(input(port));
    expect(outcome).toMatchObject({
      outcome: "unavailable",
      code: "request-intent-model-unavailable",
    });
    expect(outcome.calls).toEqual([
      { promptSha256: expect.any(String), responseSha256: null, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it.each([
    [
      "a host contract fault",
      new RequestIntentContractError("host-input-invalid", "bad host input"),
    ],
    ["an unrelated defect", new TypeError("port bug")],
  ])("propagates %s from the port unchanged", async (_name, error) => {
    const port = scriptedPort([error]);
    await expect(interpretRequest(input(port))).rejects.toBe(error);
  });

  it("propagates a host contract fault raised by admission", async () => {
    const port = scriptedPort([JSON.stringify(proposal())]);
    await expect(
      interpretRequest(input(port, { admissionInventory: [42 as unknown as string] })),
    ).rejects.toBeInstanceOf(RequestIntentContractError);
  });

  it("takes the workflow cancellation path on an operator abort, not deadline or unavailable", async () => {
    const operator = new AbortController();
    const port: RequestIntentInterpreterPort = {
      call: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new RequestIntentModelUnavailableError()),
          );
          operator.abort();
        }),
    };
    await expect(interpretRequest(input(port, { signal: operator.signal }))).rejects.toThrow(
      WORKFLOW_CANCELLED,
    );
  });

  it("stops at its own deadline with the deadline code while the operator signal is live", async () => {
    const operator = new AbortController();
    const port: RequestIntentInterpreterPort = {
      call: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const outcome = await interpretRequest(
      input(port, { deadlineMs: 20, signal: operator.signal }),
    );
    expect(outcome).toMatchObject({
      outcome: "unavailable",
      code: "request-intent-model-deadline",
    });
    expect(operator.signal.aborted).toBe(false);
  });

  it("refuses a prompt over the bound input window before any call", async () => {
    const port = scriptedPort([JSON.stringify(proposal())]);
    await expect(
      interpretRequest(input(port, { window: { maxInputTokens: 10, maxOutputTokens: 10 } })),
    ).rejects.toBeInstanceOf(RequestIntentInputBudgetError);
    expect(port.calls).toHaveLength(0);
  });
});

describe("production port", () => {
  const TRANSPORT_OVERRIDE = "DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES";
  afterEach(() => {
    delete process.env[TRANSPORT_OVERRIDE];
  });
  function portOver(completeSimple: (...args: unknown[]) => Promise<unknown>) {
    const sent: unknown[][] = [];
    const port = createRequestIntentModelPort({
      config: {} as DocsFabConfig,
      workflow: "review-documentation",
      repositoryRevision: "0".repeat(40),
      maxCalls: 1,
      connectionFactory: async () =>
        ({
          model: {},
          runtime: {
            completeSimple: (...args: unknown[]) => {
              sent.push(args);
              return completeSimple(...args);
            },
          },
        }) as never,
    });
    const call = () =>
      port.call({
        systemPrompt: "system",
        prompt: "prompt",
        maxOutputTokens: 1,
        signal: new AbortController().signal,
      });
    return { call, sent };
  }

  it("passes the transport retry bound and returns the reply text", async () => {
    const { call, sent } = portOver(async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "{}" }],
      usage: { input: 2, output: 1 },
    }));
    await expect(call()).resolves.toEqual({
      text: "{}",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(sent[0]![2]).toMatchObject({
      maxRetries: limit("retry.maxTransportRetries").value,
    });
  });

  it("maps a provider throw to unavailable", async () => {
    const { call } = portOver(async () => {
      throw new Error("socket closed");
    });
    await expect(call()).rejects.toBeInstanceOf(RequestIntentModelUnavailableError);
  });

  /** A binding of a retired installed composition: a configuration fault, not the provider. */
  const RETIRED_MODEL = {
    ...validModelConfig,
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  };

  it("propagates a model binding fault with its own code and no unavailable stop", async () => {
    const port = createRequestIntentModelPort({
      config: { model: RETIRED_MODEL } as DocsFabConfig,
      workflow: "review-documentation",
      repositoryRevision: "0".repeat(40),
      maxCalls: 1,
    });
    const refused = interpretRequest(input(port));
    await expect(refused).rejects.toMatchObject({ code: "composition-retired" });
    await expect(refused).rejects.toBeInstanceOf(ModelCompositionError);
  });

  it("stops unavailable when opening the bound connection fails (adjacent to a binding fault)", async () => {
    const opened: unknown[] = [];
    const port = createRequestIntentModelPort({
      config: { model: RETIRED_MODEL } as DocsFabConfig,
      workflow: "review-documentation",
      repositoryRevision: "0".repeat(40),
      maxCalls: 1,
      compositionRuntime: {
        executionProfile: {},
        credential: {},
        providerConnectionFactory: {
          create: async (...args: unknown[]) => {
            opened.push(args);
            throw new Error("connect ECONNREFUSED");
          },
        },
      } as never,
    });
    const outcome = await interpretRequest(input(port));
    expect(opened).toHaveLength(1);
    expect(outcome).toMatchObject({
      outcome: "unavailable",
      code: "request-intent-model-unavailable",
    });
  });

  it("admits through a healthy bound connection (positive control)", async () => {
    const port = createRequestIntentModelPort({
      config: { model: RETIRED_MODEL } as DocsFabConfig,
      workflow: "update-documentation",
      repositoryRevision: "0".repeat(40),
      maxCalls: 1,
      compositionRuntime: {
        executionProfile: {},
        credential: {},
        providerConnectionFactory: {
          create: async () => ({
            model: {},
            runtime: {
              completeSimple: async () => ({
                stopReason: "stop",
                content: [{ type: "text", text: JSON.stringify(proposal()) }],
                usage: { input: 2, output: 1 },
              }),
            },
          }),
        },
      } as never,
    });
    expect(await interpretRequest(input(port))).toMatchObject({ outcome: "admitted" });
  });

  it("propagates a refused limit override unchanged, before any provider call", async () => {
    process.env[TRANSPORT_OVERRIDE] = "not-a-number";
    const { call, sent } = portOver(async () => ({ stopReason: "stop", content: [] }));
    const refused = call();
    await expect(refused).rejects.toThrow(/DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES/u);
    await expect(refused).rejects.not.toBeInstanceOf(RequestIntentModelUnavailableError);
    expect(sent).toEqual([]);
  });
});

describe("firstJsonObject", () => {
  it("reads the first object, ignoring braces inside strings and prose around it", () => {
    expect(firstJsonObject('Here: {"a": "x}y{", "b": {"c": 1}} trailing {"d": 2}')).toEqual({
      a: "x}y{",
      b: { c: 1 },
    });
  });

  it.each(["no json here", "[1, 2]", '{"a": 1', "{not json} {}"])(
    "returns no object or the next whole one for %j",
    (text) => {
      const value = firstJsonObject(text);
      expect(value === undefined || (typeof value === "object" && !Array.isArray(value))).toBe(
        true,
      );
      if (text === "{not json} {}") expect(value).toEqual({});
      else expect(value).toBeUndefined();
    },
  );
});

describe("interpretation predicates", () => {
  it("maps exactly the four documentation workflows to an operation", () => {
    expect(declaredRequestIntentOperation("create-documentation")).toBe("create");
    expect(declaredRequestIntentOperation("update-documentation")).toBe("update");
    expect(declaredRequestIntentOperation("restructure-documentation")).toBe("restructure");
    expect(declaredRequestIntentOperation("review-documentation")).toBe("review");
    for (const workflow of [
      "release-documentation-readiness",
      "ia-analysis",
      "ia-plan",
      "readiness",
      "bootstrap",
      "toString",
    ]) {
      expect(declaredRequestIntentOperation(workflow), workflow).toBeUndefined();
    }
  });

  it("treats only PI_OFFLINE=1 as offline, the value the admission model gates on", () => {
    expect(isRequestIntentOffline({ PI_OFFLINE: "1" })).toBe(true);
    // The live CI jobs and the dogfood host export 0 and expect model calls.
    expect(isRequestIntentOffline({ PI_OFFLINE: "0" })).toBe(false);
    expect(isRequestIntentOffline({ PI_OFFLINE: "" })).toBe(false);
    expect(isRequestIntentOffline({})).toBe(false);
  });

  it("is a continuation only for a loaded continuation or an InputAsk resume", () => {
    const resume = { operatorInputResume: {} as never };
    expect(requestIntentContinuationReason({ loadedContinuation: true, request: {} })).toBe(
      "knowledge-continuation",
    );
    expect(requestIntentContinuationReason({ loadedContinuation: false, request: resume })).toBe(
      "operator-input-resume",
    );
    expect(
      requestIntentContinuationReason({
        loadedContinuation: false,
        request: { runId: "run-1" } as never,
      }),
    ).toBeUndefined();
    expect(requestIntentContinuationReason({ loadedContinuation: false, request: {} })).toBe(
      undefined,
    );
  });

  it("takes the smaller of its own deadline and the composition timeout", () => {
    const own = limit("requestIntent.interpretationTimeoutMs").value;
    const composition = (timeoutMs: number) =>
      ({
        executionProfile: {
          compositionPolicy: { timeoutMs, maxProviderTurns: 1, maxResponseBytes: 1 },
        },
      }) as unknown as CompositionRunRuntime;
    expect(requestIntentDeadlineMs()).toBe(own);
    expect(requestIntentDeadlineMs(composition(own - 1))).toBe(own - 1);
    expect(requestIntentDeadlineMs(composition(own + 1))).toBe(own);
  });
});

describe("runRequestInterpretation when the step does not ask the model", () => {
  const throwingPort: RequestIntentInterpreterPort = {
    call: async () => {
      throw new Error("the model must not be called");
    },
  };
  const base = {
    loadedContinuation: false,
    workspace: {} as RepositoryWorkspace,
    config: {} as DocsFabConfig,
    documentationRoots: undefined,
    documentationRootPolicy: "local-widen" as const,
    port: throwingPort,
  };

  it.each(["ia-analysis", "ia-plan", "release-documentation-readiness", "readiness"] as const)(
    "records %s as not-applicable without a call",
    async (workflow) => {
      const step = await runRequestInterpretation({
        ...base,
        workflow: getWorkflow(workflow),
        request: { workflow, instruction: "Update docs/cli.md." } as never,
      });
      expect(step).toMatchObject({
        kind: "continue",
        recorded: {
          admission: { outcome: "not-applicable", reason: "workflow-without-operation" },
        },
      });
    },
  );

  it.each([undefined, "", "   \n\t"])(
    "records an absent or blank instruction %j as not-applicable",
    async (instruction) => {
      const step = await runRequestInterpretation({
        ...base,
        workflow: getWorkflow("review-documentation"),
        request: { workflow: "review-documentation", instruction, allowWrite: false } as never,
      });
      expect(step).toMatchObject({
        kind: "continue",
        recorded: { admission: { outcome: "not-applicable", reason: "instruction-absent" } },
      });
    },
  );

  it("records an InputAsk resume as a continuation", async () => {
    const step = await runRequestInterpretation({
      ...base,
      workflow: getWorkflow("update-documentation"),
      request: {
        workflow: "update-documentation",
        instruction: "Update docs/cli.md.",
        allowWrite: true,
        operatorInputResume: {},
      } as never,
    });
    expect(step).toMatchObject({
      kind: "continue",
      recorded: {
        admission: { outcome: "continuation", reason: "operator-input-resume", calls: [] },
      },
    });
  });
});

describe("prompt inventory", () => {
  const bytes = new Map<string, string>();
  const read = async (path: string) => new TextEncoder().encode(bytes.get(path) ?? "");
  /** The limits the run resolves, with any value lowered for one case. */
  function limits(overrides: Partial<Record<keyof RequestIntentInventoryLimits, number>> = {}) {
    const resolved = resolvePromptInventoryLimits();
    return Object.fromEntries(
      Object.entries(resolved).map(([key, entry]) => {
        const value = overrides[key as keyof RequestIntentInventoryLimits];
        return [key, value === undefined ? entry : { ...entry, value }];
      }),
    ) as unknown as RequestIntentInventoryLimits;
  }

  it("resolves each inventory bound from its own catalog entry", () => {
    expect(
      Object.fromEntries(
        Object.entries(resolvePromptInventoryLimits()).map(([key, entry]) => [key, entry.name]),
      ),
    ).toEqual({
      maxPromptInventoryEntries: "requestIntent.maxPromptInventoryEntries",
      maxInventoryTitleChars: "requestIntent.maxInventoryTitleChars",
      maxInventoryPathChars: "requestIntent.maxInventoryPathChars",
      maxPageBytes: "authoring.plannedPageMaxBytes",
    });
  });
  const pages = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `docs/page-${String(index).padStart(4, "0")}.md`,
      kind: "regular",
      byteLength: 0,
    }));
  afterEach(() => bytes.clear());

  it("lists only tracked Markdown and MDX pages under the documentation roots", async () => {
    bytes.set("docs/a.md", "# Alpha\n");
    bytes.set("fern/b.mdx", "---\ntitle: 'Beta page'\n---\n# Ignored\n");
    const inventory = await buildRequestIntentPromptInventory({
      entries: [
        { path: "docs/a.md", kind: "regular" },
        { path: "fern/b.mdx", kind: "regular" },
        { path: "src/c.md", kind: "regular" },
        { path: "docs/d.txt", kind: "regular" },
        { path: "docs/e.md", kind: "symlink" },
        { kind: "excluded" },
      ],
      readTrackedBytes: read,
      docsRoots: ["docs/", "fern/"],
      limits: limits(),
    });
    expect(inventory).toEqual({
      entries: [
        { path: "docs/a.md", title: "Alpha", navLabel: null },
        { path: "fern/b.mdx", title: "Beta page", navLabel: null },
      ],
      clippedTitles: 0,
    });
  });

  it("admits the entry bound and refuses one page over it", async () => {
    const bound = 3;
    const at = await buildRequestIntentPromptInventory({
      entries: pages(bound),
      readTrackedBytes: read,
      docsRoots: ["docs/"],
      limits: limits({ maxPromptInventoryEntries: bound }),
    });
    expect(at.entries).toHaveLength(bound);
    const over = buildRequestIntentPromptInventory({
      entries: pages(bound + 1),
      readTrackedBytes: read,
      docsRoots: ["docs/"],
      limits: limits({ maxPromptInventoryEntries: bound }),
    });
    await expect(over).rejects.toMatchObject({
      code: "request-intent-max-prompt-inventory-entries-bound",
      observed: bound + 1,
    });
    await expect(over).rejects.toBeInstanceOf(OperationalLimitError);
  });

  it("admits a path at its bound and refuses one character over it", async () => {
    const bound = limit("requestIntent.maxInventoryPathChars").value;
    const path = (length: number) =>
      `docs/${"p".repeat(length - "docs/".length - ".md".length)}.md`;
    const at = await buildRequestIntentPromptInventory({
      entries: [{ path: path(bound), kind: "regular" }],
      readTrackedBytes: read,
      docsRoots: ["docs/"],
      limits: limits(),
    });
    expect(at.entries[0]!.path).toHaveLength(bound);
    await expect(
      buildRequestIntentPromptInventory({
        entries: [{ path: path(bound + 1), kind: "regular" }],
        readTrackedBytes: read,
        docsRoots: ["docs/"],
        limits: limits(),
      }),
    ).rejects.toMatchObject({ code: "request-intent-max-inventory-path-chars-bound" });
  });

  it("admits a listed page size at its bound and refuses one byte over it before any read", async () => {
    const bound = limit("authoring.plannedPageMaxBytes").value;
    const reads: string[] = [];
    const counting = async (path: string) => {
      reads.push(path);
      return new TextEncoder().encode("# Alpha\n");
    };
    const at = await buildRequestIntentPromptInventory({
      entries: [{ path: "docs/a.md", kind: "regular", byteLength: bound }],
      readTrackedBytes: counting,
      docsRoots: ["docs/"],
      limits: limits(),
    });
    expect(at.entries).toEqual([{ path: "docs/a.md", title: "Alpha", navLabel: null }]);
    reads.length = 0;
    const over = buildRequestIntentPromptInventory({
      entries: [
        { path: "docs/a.md", kind: "regular", byteLength: 0 },
        { path: "docs/b.md", kind: "regular", byteLength: bound + 1 },
      ],
      readTrackedBytes: counting,
      docsRoots: ["docs/"],
      limits: limits(),
    });
    await expect(over).rejects.toMatchObject({
      code: "authoring-planned-page-max-bytes-bound",
      observed: bound + 1,
    });
    await expect(over).rejects.toBeInstanceOf(OperationalLimitError);
    expect(reads).toEqual([]);
  });

  it("clips a title over its bound with an ellipsis and counts it; one at the bound is kept", async () => {
    const bound = limit("requestIntent.maxInventoryTitleChars").value;
    bytes.set("docs/a.md", `# ${"a".repeat(bound)}\n`);
    bytes.set("docs/b.md", `# ${"b".repeat(bound + 1)}\n`);
    const inventory = await buildRequestIntentPromptInventory({
      entries: [
        { path: "docs/a.md", kind: "regular" },
        { path: "docs/b.md", kind: "regular" },
      ],
      readTrackedBytes: read,
      docsRoots: ["docs/"],
      limits: limits(),
    });
    expect(inventory.clippedTitles).toBe(1);
    expect(inventory.entries[0]!.title).toBe("a".repeat(bound));
    expect(inventory.entries[1]!.title).toHaveLength(bound);
    expect(inventory.entries[1]!.title!.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair when it clips", () => {
    expect(clipTitle("ab😀cd", 4)).toBe("ab…");
    expect(clipTitle("abc", 3)).toBe("abc");
  });

  it("reads a frontmatter title first and skips a heading inside a code fence", () => {
    expect(pageTitle("---\ntitle: Front\n---\n# Body\n")).toBe("Front");
    expect(pageTitle("```\n# Not a title\n```\n# Real ##\n")).toBe("Real");
    expect(pageTitle("## Second level only\n")).toBeNull();
  });

  it("fits the smallest shipped profile's input window at the default page count", async () => {
    const profileDir = join(runtimeRoot, "config/profiles");
    const windows = await Promise.all(
      (await readdir(profileDir))
        .filter((name) => name.endsWith(".yaml"))
        .map(async (name) =>
          Number(
            /^maxInputTokens:\s*(\d+)\s*$/mu.exec(
              await readFile(join(profileDir, name), "utf8"),
            )?.[1],
          ),
        ),
    );
    const smallest = Math.min(...windows);
    expect(Number.isSafeInteger(smallest)).toBe(true);
    const entries = limit("requestIntent.maxPromptInventoryEntries").value;
    const pathChars = limit("requestIntent.maxInventoryPathChars").value;
    // Real pages, not the bounds: the longest FastMCP page path is 80
    // characters, and a title of the same length. Navigation labels are not
    // read yet, so every label is null. At the path and title bounds a page
    // costs about five times as much; that prompt meets the input-window
    // refusal before any call instead.
    const pageChars = 80;
    const inventory: RequestIntentPromptInventory = {
      entries: Array.from({ length: entries }, (_, index) => {
        const stem = `docs/${String(index).padStart(5, "0")}`;
        return {
          path: `${stem}${"p".repeat(pageChars - stem.length - ".md".length)}.md`,
          title: "t".repeat(pageChars),
          navLabel: null,
        };
      }),
      clippedTitles: 0,
    };
    // Every documentation root admission accepts, each at the longest listed path.
    const documentationRoots = Array.from(
      { length: limit("requestIntent.maxDocsRootEntries").value },
      (_, index) => {
        const stem = `site/${String(index).padStart(5, "0")}`;
        return { kind: "root" as const, path: `${stem}${"r".repeat(pathChars - stem.length)}` };
      },
    );
    const prompt = renderRequestIntentPrompt({
      workflow: "restructure-documentation",
      operation: "restructure",
      instruction: "Split docs/cli.md into task pages and keep the navigation in step.",
      inventory,
      documentationRoots,
      navigationSet: [],
    });
    const tokens = estimateModelRequestTokens({
      systemPrompt: REQUEST_INTENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });
    expect(tokens).toBeLessThanOrEqual(smallest);
  });
});

/**
 * Host verb-independence: one fixed proposal, quotes regrounded per phrasing.
 * It proves the host makes no decision on the request's verb, not that a model
 * reads every phrasing the same way.
 */
describe("paraphrase suite", () => {
  const PHRASINGS = [
    // create-cli-configuration: "Add" was outside the old write-verb lexicon.
    ["add", "Add a configuration section to docs/cli.md for the profile file."],
    ["create", "Create docs/cli.md describing the profile file."],
    ["write-up", "Write up the profile options in docs/cli.md."],
    ["document", "Document the profile file in docs/cli.md."],
    // update-telemetry-configuration: "Bring … up to date" failed the old update regex.
    ["bring-up-to-date", "Bring docs/cli.md up to date with the telemetry settings."],
    // update-cli-reference: an indirect request.
    ["please-make", "Please make docs/cli.md match the current CLI."],
    // restructure-sdk-reference: a split.
    ["split", "Split docs/cli.md into task pages."],
    // conflicting-service-port: a question-shaped request.
    ["assess", "Assess whether docs/cli.md still lists the right port."],
  ] as const;

  it.each(PHRASINGS)("admits the same intent for %s", async (_case, instruction) => {
    const port = scriptedPort([JSON.stringify(proposal())]);
    const outcome = await interpretRequest(input(port, { instruction }));
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome !== "admitted") return;
    expect(outcome.intent.operation).toBe("update");
    expect(
      outcome.intent.targets.map(({ path, role, chosenFrom }) => ({ path, role, chosenFrom })),
    ).toEqual([{ path: "docs/cli.md", role: "write", chosenFrom: "named" }]);
    expect(requestIntentWriteSet(outcome.intent)).toEqual(["docs/cli.md"]);
    // The quote is regrounded on this phrasing's own text.
    const quote = outcome.intent.targets[0]!.quote;
    expect(instruction.normalize("NFC").slice(quote.start, quote.end)).toBe("docs/cli.md");
  });

  it("narrows the write set through an exclusion and refuses one that contradicts a target", async () => {
    const instruction = "Update docs/a.md and docs/b.md, but leave docs/a.md alone.";
    const narrowed = await interpretRequest(
      input(
        scriptedPort([
          JSON.stringify(
            proposal({
              targets: [
                { path: "docs/b.md", role: "write", chosenFrom: "named", quote: "docs/b.md" },
              ],
              exclusions: [{ path: "docs/a.md", quote: "leave docs/a.md alone" }],
            }),
          ),
        ]),
        { instruction },
      ),
    );
    expect(narrowed.outcome === "admitted" && requestIntentWriteSet(narrowed.intent)).toEqual([
      "docs/b.md",
    ]);
    const contradicted = await interpretRequest(
      input(
        scriptedPort([
          JSON.stringify(
            proposal({
              targets: [
                { path: "docs/a.md", role: "write", chosenFrom: "named", quote: "docs/a.md" },
                { path: "docs/b.md", role: "write", chosenFrom: "named", quote: "docs/b.md" },
              ],
              exclusions: [{ path: "docs/a.md", quote: "leave docs/a.md alone" }],
            }),
          ),
        ]),
        { instruction, maxRetries: 0 },
      ),
    );
    expect(contradicted).toMatchObject({
      outcome: "rejected",
      code: "request-intent-excluded-target",
    });
  });
});
