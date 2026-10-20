// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reasoning Pi replays on an assistant turn, through the real Pi harness and
 * the installed Inference Hub Nemotron 3 Ultra request policy.
 *
 * When a provider streams a reasoning delta, Pi stores a thinking block and
 * replays it on the next request as a top-level assistant key named after the
 * delta field. The reasoning-off policy omits it, records the omission beside
 * the digest of the payload it sent, and still refuses any other unlisted key
 * by a coded reason. Every provider here is a scripted `fetch`; no request
 * leaves the host.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { classifyAttemptRow } from "../src/diagnosis/classify.js";
import type { HarnessStepInput, InferenceRetryPolicy } from "../src/execution/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import type { InstalledRequestPolicy } from "../src/model-composition/types.js";
import { accountProviderAttempts } from "../src/model/provider-attempt.js";
import { isAdmissibleRequestPolicyRefusal } from "../src/model/request-policy-refusals.js";
import {
  createProviderConnectionFactory,
  type ProviderConnectionFactory,
} from "../src/model/provider.js";
import { attachRunFailureClassifications } from "../src/operator/failure-classification.js";
import type { InferenceExecutionEvidence, RunRecord } from "../src/records/contracts.js";
import { evaluateStructure, parseEvaluationFixture } from "../src/quality-evaluation/structural.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { validModelConfig } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const SLOW = testTimeoutMs(30_000);
const temporaryDirectories: string[] = [];
const CREDENTIAL = "hub-replayed-reasoning-test-credential";
const ULTRA_COMPOSITION = "nvidia-inference-nemotron-3-ultra-pi";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** The sealed request policy of the installed Hub Ultra composition. */
function installedUltraPolicy(): InstalledRequestPolicy {
  const registry = JSON.parse(
    readFileSync(resolve(projectRoot, "model-compositions/composition-registry.json"), "utf8"),
  ) as {
    compositions: {
      compositionId: string;
      requestPolicy?: InstalledRequestPolicy;
    }[];
  };
  const policy = registry.compositions.find(
    (composition) => composition.compositionId === ULTRA_COMPOSITION,
  )?.requestPolicy;
  if (!policy) throw new Error(`${ULTRA_COMPOSITION} carries no request policy.`);
  return policy;
}

function hubUltraProfile(policy = installedUltraPolicy()): BoundModelExecutionProfile {
  return {
    routeId: "nvidia-inference-api",
    providerId: "nvidia-inference-api",
    baseUrl: EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"],
    modelId: policy.modelId,
    transport: "openai-chat-completions",
    apiFormat: "chat_completions",
    profile: {
      ...validModelConfig.profile,
      reasoning: false,
      compatibility: {
        ...validModelConfig.profile.compatibility,
        supportsReasoningEffort: false,
        apiFormats: ["chat_completions"],
      },
    },
    requestPolicy: validModelConfig.requestPolicy,
    compositionRequestPolicy: policy,
    compositionPolicy: {
      maxProviderTurns: 8,
      timeoutMs: 300_000,
      maxResponseBytes: 4_194_304,
    },
  };
}

function sse(model: string, deltas: readonly object[], finish: string): Response {
  const chunk = (delta: object, finishReason: string | null, extra: object = {}) => ({
    id: "hub-turn",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  });
  return new Response(
    [
      ...deltas.map((delta) => chunk(delta, null)),
      chunk({}, finish, {
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ]
      .map((item) => `data: ${JSON.stringify(item)}\n\n`)
      .concat("data: [DONE]\n\n")
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const readCall = {
  role: "assistant",
  tool_calls: [
    {
      index: 0,
      id: "call-read-1",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "README.md" }),
      },
    },
  ],
};

interface StepRun {
  readonly requests: Record<string, unknown>[];
  readonly evidence: InferenceExecutionEvidence;
  readonly status: string;
  readonly error: string;
}

/** One read-only step: a first turn the caller scripts, then a final answer. */
async function runStep(
  firstTurn: readonly object[],
  profile = hubUltraProfile(),
  readme = "# Fixture\n",
): Promise<StepRun> {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-replayed-reasoning-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), readme);
  const requests: Record<string, unknown>[] = [];
  const queue = [
    sse(profile.modelId, firstTurn, "tool_calls"),
    sse(profile.modelId, [{ role: "assistant", content: "The review is complete." }], "stop"),
  ];
  const base = createProviderConnectionFactory({
    routeId: "nvidia-inference-api",
    transport: "openai-chat-completions",
    fetch: async (_request, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = queue.shift();
      if (!next) throw new Error("The scripted provider has no response left.");
      return next;
    },
  });
  const factory: ProviderConnectionFactory = {
    routeId: base.routeId,
    transport: base.transport,
    create: (input, turnOptions) =>
      base.create(input, {
        ...turnOptions,
        providerTurnRetry: {
          baseDelayMs: 0,
          maxDelayMs: 0,
          maxAttempts: 1,
          maxBlankAttempts: 1,
        },
      } as never),
  };
  const harness = new PiHarness({
    skillCrateDirectory,
    executionProfile: profile,
    credential: { family: "nvidia-inference-api", apiKey: CREDENTIAL },
    providerConnectionFactory: factory,
  });
  const workflow = getWorkflow("review-documentation");
  const input: HarnessStepInput = {
    runId: "hub-replayed-reasoning-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
  const policy: InferenceRetryPolicy = {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableCategories: [],
  };
  const execution = await executeInferenceStep({
    mode: "read-only",
    policy,
    evidenceIdentity: input.evidenceIdentity,
    sleep: async () => undefined,
    execute: (attempt) =>
      harness.runStep({
        ...input,
        inferenceAttempt: attempt,
        retriesConsumed: attempt - 1,
      }),
  });
  const failed = execution as { error?: unknown };
  return {
    requests,
    evidence: execution.evidence,
    status: execution.status,
    error: failed.error instanceof Error ? failed.error.message : "",
  };
}

function assistantMessages(request: Record<string, unknown>): Record<string, unknown>[] {
  return (request.messages as Record<string, unknown>[]).filter(
    (message) => message.role === "assistant",
  );
}

/** The run index row and `docsfab why` reading of a step's terminal attempt. */
function terminalAttemptReading(run: StepRun) {
  const record = {
    schemaVersion: 2,
    id: "replayed-reasoning-run",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/fixture",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-10-01T12:00:00.000Z",
    models: [],
    skills: [],
    steps: [
      {
        id: "derive-source-obligations",
        title: "Derive source obligations",
        skill: "derive-source-obligations",
        mode: "read-only",
        status: "failed",
        inference: run.evidence,
      },
    ],
  } as unknown as RunRecord;
  attachRunFailureClassifications(record);
  const projection = projectRunIndexRows(record, {
    origin: "import",
    snapshotId: "snapshot-1",
    indexedAt: "2026-10-01T12:00:00.000Z",
    recordSha256: "a".repeat(64),
    fieldMaxChars: 512,
  });
  if (!projection.ok) throw new Error(`record refused: ${projection.reason}`);
  const row = projection.rows.find((candidate) => candidate.rowKind === "attempt")!;
  const runRow = projection.rows.find((candidate) => candidate.rowKind === "run")!;
  return {
    record,
    row,
    runRow,
    reading: classifyAttemptRow(row, {
      whyJson: "docsfab why x --json",
      runsShow: "docsfab runs show x",
    }),
  };
}

describe("installed request policy: reasoning Pi replays on an assistant turn", () => {
  it.each([
    ["reasoning_content", { role: "assistant", reasoning_content: "I should read it." }],
    ["reasoning", { role: "assistant", reasoning: "I should read it." }],
  ])(
    "omits a replayed %s field and records it beside the sent payload's digest",
    async (field, reasoningDelta) => {
      const run = await runStep([reasoningDelta, readCall]);

      expect(run.error).toBe("");
      expect(run.status).toBe("succeeded");
      expect(run.requests).toHaveLength(2);
      const [replayed] = assistantMessages(run.requests[1]!);
      expect(replayed).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-read-1",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "README.md" }),
            },
          },
        ],
      });
      expect(JSON.stringify(run.requests[1])).not.toContain(field);
      expect(JSON.stringify(run.requests[1])).not.toContain("I should read it.");
      const turns = run.evidence.attempts.at(-1)!.turns!;
      expect(turns.map((turn) => turn.replayedReasoningOmitted)).toEqual([undefined, 1]);
      expect(turns[1]!.finalPayloadSha256).toBe(canonicalDigest(run.requests[1]!));
      expect(() => decodeInference(structuredClone(run.evidence))).not.toThrow();
    },
    SLOW,
  );

  it(
    "replays a denied tool path and an empty file as non-empty tool results and sends them",
    async () => {
      const deniedRead = {
        role: "assistant",
        tool_calls: [
          {
            ...readCall.tool_calls[0]!,
            function: { name: "read", arguments: '{"path":"/etc/hosts"}' },
          },
        ],
      };
      const run = await runStep([{ role: "assistant", content: "  \n" }, deniedRead]);

      expect(run.status).toBe("succeeded");
      expect(run.requests).toHaveLength(2);
      const messages = run.requests[1]!.messages as Record<string, unknown>[];
      expect(messages.at(-2)).toMatchObject({
        role: "assistant",
        content: null,
      });
      expect(messages.at(-1)).toEqual({
        role: "tool",
        tool_call_id: "call-read-1",
        content: "DocsFab denied the requested tool path.",
      });
    },
    SLOW,
  );

  it(
    "records no omission when the turn streamed no reasoning",
    async () => {
      const run = await runStep([readCall]);

      expect(run.status).toBe("succeeded");
      const turns = run.evidence.attempts.at(-1)!.turns!;
      expect(turns.every((turn) => turn.replayedReasoningOmitted === undefined)).toBe(true);
      expect(turns[1]!.finalPayloadSha256).toBe(canonicalDigest(run.requests[1]!));
      expect(() => decodeInference(structuredClone(run.evidence))).not.toThrow();
    },
    SLOW,
  );
});

describe("installed request policy: a coded refusal through the harness", () => {
  it(
    "records the refusal on the unsealed turn and classifies it by its own code",
    async () => {
      // An installed policy whose digest no longer verifies is refused before
      // any payload is sealed or sent.
      const tampered = {
        ...installedUltraPolicy(),
        policySha256: "0".repeat(64),
      };
      const run = await runStep([readCall], hubUltraProfile(tampered));

      expect(run.status).toBe("failed");
      expect(run.requests).toHaveLength(0);
      expect(run.error).toContain(
        "Provider request rejected by the installed request policy (policy-subject).",
      );
      const attempt = run.evidence.attempts.at(-1)!;
      expect(attempt.outcome).toBe("provider-terminal");
      const refusedTurn = attempt.turns!.at(-1)!;
      expect(refusedTurn.requestPolicyRefusal).toBe("policy-subject");
      expect(refusedTurn.finalPayloadSha256).toBeUndefined();
      expect(() => decodeInference(structuredClone(run.evidence))).not.toThrow();
      expect(accountProviderAttempts(attempt.turns)).toMatchObject({
        physicalRequests: 0,
        requestPolicyRefusedTurns: 1,
        unaccountedTurns: 0,
        coverage: "complete",
      });

      const { record, row, runRow, reading } = terminalAttemptReading(run);
      expect(record.failure).toEqual({
        class: "operator-input",
        layer: "inference",
        code: "request-policy-policy-subject",
      });
      expect([row.failureCode, runRow.failureCode]).toEqual([
        "request-policy-policy-subject",
        "request-policy-policy-subject",
      ]);
      expect(reading.cause).toBe("installed-policy-unverified");
      expect(reading.ownerClass).toBe("operator-configuration");
      expect(reading.signature).toEqual({
        failureCode: "request-policy-policy-subject",
      });
    },
    SLOW,
  );

  it(
    "leaves a credential-boundary refusal of the same hook uncoded as a policy refusal",
    async () => {
      // The model's read call names a path that holds the selected credential,
      // so the turn carrying it is refused by the credential boundary, not by
      // the request policy.
      const credentialReadCall = {
        ...readCall,
        tool_calls: [
          {
            ...readCall.tool_calls[0]!,
            function: { name: "read", arguments: JSON.stringify({ path: `${CREDENTIAL}.md` }) },
          },
        ],
      };
      const run = await runStep([credentialReadCall], hubUltraProfile());

      expect(run.status).toBe("failed");
      expect(run.requests).toHaveLength(1);
      const attempt = run.evidence.attempts.at(-1)!;
      expect(attempt.turns!.some((turn) => turn.requestPolicyRefusal !== undefined)).toBe(false);
      const { row } = terminalAttemptReading(run);
      expect(row.failureCode).not.toMatch(/^request-policy-/u);
    },
    SLOW,
  );

  it(
    "refuses to read a file that holds the selected credential, so no request carries it",
    async () => {
      // The confined read screens the whole file for DocsFab's own configured
      // credentials, the selected model key among them (#1807). The model gets
      // a refused read, never the key, and the step goes on.
      const run = await runStep([readCall], hubUltraProfile(), `# Fixture ${CREDENTIAL}\n`);

      expect(run.requests).toHaveLength(2);
      expect(JSON.stringify(run.requests)).not.toContain(CREDENTIAL);
      expect(JSON.stringify(run.requests[1])).toContain("credential-isolation boundary");
      const attempt = run.evidence.attempts.at(-1)!;
      expect(attempt.turns!.some((turn) => turn.requestPolicyRefusal !== undefined)).toBe(false);
    },
    SLOW,
  );
});

describe("installed request policy: the turn record contract", () => {
  it(
    "admits the new turn fields only where the record can carry them",
    async () => {
      const run = await runStep([{ role: "assistant", reasoning_content: "Thinking." }, readCall]);
      const decode = (edit: (turns: Record<string, unknown>[]) => void) => {
        const evidence = structuredClone(run.evidence);
        const attempt = evidence.attempts.at(-1)!;
        edit(attempt.turns! as unknown as Record<string, unknown>[]);
        // The lease seals the ledger it ran; drop it so only the turn rules decide.
        delete attempt.executionLease;
        return () => decodeInference(evidence);
      };

      expect(decode(() => undefined)).not.toThrow();
      // An omission is counted only on a policed, sealed payload.
      // The policy digest is the same on every turn of an attempt, so it is
      // dropped from all of them; without the omission that record decodes.
      expect(
        decode((turns) => {
          for (const turn of turns) delete turn.requestPolicySha256;
        }),
      ).toThrow();
      expect(
        decode((turns) => {
          for (const turn of turns) delete turn.requestPolicySha256;
          delete turns[1]!.replayedReasoningOmitted;
        }),
      ).not.toThrow();
      expect(
        decode((turns) => {
          turns[1]!.replayedReasoningOmitted = 0;
        }),
      ).toThrow();
      // A refusal ends the attempt, so only its last turn carries one.
      expect(
        decode((turns) => {
          // Admitted on a sealed last turn (below), refused on an earlier one.
          turns[0]!.requestPolicyRefusal = "payload-authority";
        }),
      ).toThrow();
      // A sealed turn is refused only by the replay ledger check or the send
      // gate, and the send gate never sees an unsealed payload.
      expect(
        decode((turns) => {
          turns[1]!.requestPolicyRefusal = "message-shape";
        }),
      ).toThrow();
      for (const refusal of ["payload-authority", "payload-send"]) {
        expect(
          decode((turns) => {
            turns[1]!.requestPolicyRefusal = refusal;
          }),
        ).not.toThrow();
      }
      // The send gate never sees an unsealed payload: on the turn a tampered
      // policy refused before sealing, only a pre-seal refusal is admitted.
      const tampered = { ...installedUltraPolicy(), policySha256: "0".repeat(64) };
      const refused = await runStep([readCall], hubUltraProfile(tampered));
      const decodeRefused = (refusal: string) => {
        const evidence = structuredClone(refused.evidence);
        const attempt = evidence.attempts.at(-1)!;
        delete attempt.executionLease;
        (attempt.turns!.at(-1) as unknown as Record<string, unknown>).requestPolicyRefusal =
          refusal;
        return () => decodeInference(evidence);
      };
      expect(decodeRefused("message-shape")).not.toThrow();
      expect(decodeRefused("payload-send")).toThrow();
      expect(
        decode((turns) => {
          turns[1]!.requestPolicyRefusal = "message-73";
        }),
      ).toThrow();
    },
    SLOW,
  );
});

describe("installed request policy: which refusals the governed turn records", () => {
  async function governedTurn(options: {
    onPayload?: (payload: unknown) => unknown;
    beforeProviderTurn?: () => void;
    respond?: (call: number) => Response;
    sdkRetries?: number;
    inTurnAttempts?: number;
  }) {
    const profile = hubUltraProfile();
    let calls = 0;
    const connection = await createProviderConnectionFactory({
      routeId: "nvidia-inference-api",
      transport: "openai-chat-completions",
      fetch: async () => {
        calls += 1;
        return (
          options.respond?.(calls) ??
          sse(profile.modelId, [{ role: "assistant", content: "OK" }], "stop")
        );
      },
    }).create({ profile, credential: { family: "nvidia-inference-api", apiKey: CREDENTIAL } }, {
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      providerTurnRetry: {
        baseDelayMs: 0,
        maxDelayMs: 0,
        maxAttempts: options.inTurnAttempts ?? 1,
        maxBlankAttempts: 1,
      },
      ...(options.beforeProviderTurn ? { beforeProviderTurn: options.beforeProviderTurn } : {}),
    } as never);
    const result = (await connection.runtime
      .streamSimple(
        connection.model,
        {
          systemPrompt: "Reply OK.",
          messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 1 }],
          tools: [],
        },
        {
          maxTokens: 64,
          ...(options.onPayload ? { onPayload: options.onPayload } : {}),
          ...(options.sdkRetries === undefined
            ? {}
            : { maxRetries: options.sdkRetries, maxRetryDelayMs: 0 }),
        } as never,
      )
      .result()) as { stopReason?: unknown; errorMessage?: unknown };
    const ledger = connection.turnGovernance!.evidence();
    return { calls, result, ledger, turn: ledger.at(-1)! };
  }

  it("records a second transport call for a sent payload at the send gate", async () => {
    // Pi's own request retry calls the transport again for the payload the
    // gate already sent once; DocsFab never enables it, so this is the only way
    // to reach the gate's fetch-time refusal through a real connection.
    const run = await governedTurn({
      sdkRetries: 1,
      respond: () =>
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    });

    expect(run.calls).toBe(1);
    expect(run.result.stopReason).toBe("error");
    expect(run.turn.requestPolicyRefusal).toBe("payload-resend");
    expect(run.turn.finalPayloadSha256).toBeDefined();
    // The first request was sent, so it still counts.
    expect(accountProviderAttempts(run.ledger)).toMatchObject({
      physicalRequests: 1,
      requestPolicyRefusedTurns: 0,
      coverage: "complete",
    });
  });

  it("writes no shape refusal on a sealed row, where no reader admits one", async () => {
    // Attempt 1 is sealed and fails in transport; the in-turn replay's payload
    // hook then carries an unlisted key, which a replay of the sealed request
    // never does today. The recorder skips it instead of writing a row the
    // record readers refuse.
    let payloadCalls = 0;
    const run = await governedTurn({
      inTurnAttempts: 2,
      respond: (call) => {
        if (call === 1) throw new TypeError("fetch failed: Connection error");
        return sse(installedUltraPolicy().modelId, [{ role: "assistant", content: "OK" }], "stop");
      },
      onPayload: (payload) => {
        payloadCalls += 1;
        if (payloadCalls === 1) return undefined;
        const record = payload as { messages: Record<string, unknown>[] };
        return {
          ...record,
          messages: [...record.messages, { role: "assistant", content: "x", refusal: "no" }],
        };
      },
    });

    expect(payloadCalls).toBe(2);
    expect(run.calls).toBe(1);
    expect(run.turn.finalPayloadSha256).toBeDefined();
    expect(Object.hasOwn(run.turn, "requestPolicyRefusal")).toBe(false);
  });

  it("refuses a send-gate reason on an unsealed row and a shape reason on a sealed one", () => {
    expect(isAdmissibleRequestPolicyRefusal("message-shape", false)).toBe(true);
    expect(isAdmissibleRequestPolicyRefusal("payload-authority", false)).toBe(true);
    for (const sendGate of ["payload-send", "payload-resend"]) {
      expect(isAdmissibleRequestPolicyRefusal(sendGate, false)).toBe(false);
      expect(isAdmissibleRequestPolicyRefusal(sendGate, true)).toBe(true);
    }
    expect(isAdmissibleRequestPolicyRefusal("payload-authority", true)).toBe(true);
    expect(isAdmissibleRequestPolicyRefusal("message-shape", true)).toBe(false);
    expect(isAdmissibleRequestPolicyRefusal("message-73", false)).toBe(false);
  });

  it("records a policy refusal the payload hook raised, before any request", async () => {
    const run = await governedTurn({
      onPayload: (payload) => {
        const record = payload as { messages: Record<string, unknown>[] };
        return {
          ...record,
          messages: [...record.messages, { role: "assistant", content: "x", refusal: "no" }],
        };
      },
    });

    expect(run.calls).toBe(0);
    expect(run.result.stopReason).toBe("error");
    expect(run.turn.requestPolicyRefusal).toBe("message-shape");
    expect(run.turn.finalPayloadSha256).toBeUndefined();
  });

  it("records nothing for another refusal thrown through the same hook", async () => {
    const run = await governedTurn({
      beforeProviderTurn: () => {
        throw new Error("The host lease refused this provider turn for the test.");
      },
    });

    expect(run.calls).toBe(0);
    expect(run.result.stopReason).toBe("error");
    expect(run.turn.finalPayloadSha256).toBeDefined();
    expect(Object.hasOwn(run.turn, "requestPolicyRefusal")).toBe(false);
  });

  it("records nothing for a credential refusal raised while finalizing", async () => {
    // The payload hook adds the selected credential after the context-level
    // guard ran, so the finalizer's credential boundary refuses before sealing.
    const run = await governedTurn({
      onPayload: (payload) => {
        const record = payload as { messages: Record<string, unknown>[] };
        return {
          ...record,
          messages: [...record.messages, { role: "user", content: `key ${CREDENTIAL}` }],
        };
      },
    });

    expect(run.calls).toBe(0);
    expect(run.result.stopReason).toBe("error");
    expect(run.turn.finalPayloadSha256).toBeUndefined();
    expect(Object.hasOwn(run.turn, "requestPolicyRefusal")).toBe(false);
  });

  it("records nothing on a turn the policy admitted", async () => {
    const run = await governedTurn({});

    expect(run.calls).toBe(1);
    expect(Object.hasOwn(run.turn, "requestPolicyRefusal")).toBe(false);
    expect(run.turn.finalPayloadSha256).toBeDefined();
  });
});

describe("installed request policy: the structural evaluator's turn rules", () => {
  /** The turn-governance verdict the structural evaluator gives one step's evidence. */
  function governanceVerdict(evidence: InferenceExecutionEvidence): string {
    const record = {
      id: "request-policy-structural",
      repository: { revision: "a".repeat(40) },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "derive-source-obligations",
          status: "succeeded",
          mode: "read-only",
          inference: structuredClone(evidence),
        },
      ],
    } as unknown as RunRecord;
    const fixture = parseEvaluationFixture({
      version: 1,
      name: "request policy evidence",
      assertions: [{ type: "turn-governance-evidence" }],
    });
    return evaluateStructure(fixture, [record]).results[0]?.message ?? "";
  }

  it(
    "admits the recorded fields and names each misplaced one",
    async () => {
      const run = await runStep([{ role: "assistant", reasoning_content: "Thinking." }, readCall]);
      const verdict = (edit: (turns: Record<string, unknown>[]) => void) => {
        const evidence = structuredClone(run.evidence);
        edit(evidence.attempts.at(-1)!.turns! as unknown as Record<string, unknown>[]);
        return governanceVerdict(evidence);
      };

      // Accepting controls: the real record, and a send-gate refusal on its sealed last turn.
      expect(verdict(() => undefined)).not.toContain("invalid request policy evidence");
      expect(
        verdict((turns) => {
          turns[1]!.requestPolicyRefusal = "payload-send";
        }),
      ).not.toContain("invalid request policy evidence");
      for (const edit of [
        (turns: Record<string, unknown>[]) => {
          turns[0]!.requestPolicyRefusal = "payload-authority";
        },
        (turns: Record<string, unknown>[]) => {
          turns[1]!.requestPolicyRefusal = "message-shape";
        },
        (turns: Record<string, unknown>[]) => {
          turns[1]!.replayedReasoningOmitted = 0;
        },
        (turns: Record<string, unknown>[]) => {
          for (const turn of turns) delete turn.requestPolicySha256;
        },
      ]) {
        expect(verdict(edit)).toContain("invalid request policy evidence");
      }
    },
    SLOW,
  );
});
