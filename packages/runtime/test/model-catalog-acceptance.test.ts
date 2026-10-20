// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RepositorySecurityScanner, SecurityScanReport } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { diagnose } from "../src/doctor.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import {
  InferenceHubMetadataError,
  inspectInferenceHubMetadata,
} from "../src/model/inference-hub-metadata.js";
import { approveModelProfile } from "../src/model/profile-approval.js";
import {
  applyProfileConfiguration,
  applyProfileRollback,
  loadProfileApprovalEndpoint,
  prepareProfileApply,
  prepareProfileRollback,
} from "../src/model/profile-apply.js";
import {
  type ModelProfileInspectionV1,
  inspectModelEndpointProfile,
} from "../src/model/profile-inspection.js";
import { detectCredentialRuleIdsInValue } from "../src/security/repository-scanner.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { profileApprovalFixture } from "./profile-approval-fixture.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-08-04T12:34:56.789Z");
const EXPIRED = new Date("2026-09-02T12:34:56.789Z");
const MODEL_ID = "openai/gpt-5.4";
const QUALIFIED_MODEL_ID = "azure/openai/gpt-5.4";
const INFERENCE_KEY = `nvapi-${"A".repeat(24)}`;
const METADATA_KEY = `ihub_api_${"B".repeat(24)}`;
const METADATA_ORIGIN = "https://metadata.example.test";
const METADATA_PATH = "/v1/catalog/search";
const lifecycleIt = process.env.DOCSFAB_RUN_CATALOG_ACCEPTANCE === "1" ? it : it.skip;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model catalog lifecycle acceptance", () => {
  lifecycleIt.each(["policy", "judge"] as const)(
    "takes an unknown %s profile through approval, outage, expiry, refresh, and rollback",
    async (purpose) => {
      const fixture = await createRoot(purpose === "judge");
      try {
        const initial = await loadProfileApprovalEndpoint({
          projectRoot: fixture.root,
          purpose,
          ambientEnvironment: {},
          now: NOW,
        });
        expect(initial.profile).toMatchObject({
          contextWindow: 8_192,
          maxOutputTokens: 4_096,
          effectiveLimitReason: "metadata-unknown",
          metadata: { status: "unknown" },
        });

        const inspection = await inspect(initial, purpose, NOW, catalogFetch());
        expect(inspection.catalog.reconciliation).toMatchObject({ status: "proposed" });
        const first = approve(inspection, initial, purpose, {
          effectiveDate: "2026-08-04",
          reviewAfter: "2026-09-01",
          now: NOW,
        });
        const firstReceipt = await apply(
          fixture.root,
          purpose,
          inspection,
          first.bundle,
          first.authority,
          resolve(fixture.privateRoot, `${purpose}-initial-apply.json`),
          NOW,
        );

        const current = await loadProfileApprovalEndpoint({
          projectRoot: fixture.root,
          purpose,
          ambientEnvironment: {},
          now: NOW,
        });
        expect(current.profile).toMatchObject({
          configuredLimits: {
            contextWindow: 128_000,
            maxInputTokens: 96_000,
            maxOutputTokens: 20_000,
          },
          contextWindow: 128_000,
          maxInputTokens: 96_000,
          maxOutputTokens: 20_000,
          effectiveLimitReason: "none",
          metadata: { status: "current", reviewAfter: "2026-09-01" },
        });

        const currentPolicy =
          purpose === "judge"
            ? await loadProfileApprovalEndpoint({
                projectRoot: fixture.root,
                purpose: "policy",
                ambientEnvironment: {},
                now: NOW,
              })
            : undefined;
        if (currentPolicy) {
          expect(currentPolicy.profile).toMatchObject({
            effectiveLimitReason: "metadata-unknown",
            metadata: { status: "unknown" },
          });
        }
        const doctor = await diagnose(doctorConfig(fixture.root, current, purpose, currentPolicy), {
          live: false,
        });
        expect(purpose === "policy" ? doctor.profile : doctor.judge?.profile).toMatchObject({
          metadata: { status: "current" },
        });

        const outage = await inspect(current, purpose, NOW, async () => {
          throw new Error(`${INFERENCE_KEY}:${METADATA_KEY}:provider detail`);
        });
        expect(outage.runtime).toMatchObject({ profileStatus: "current", fallbackApplied: false });
        expect(outage.catalog.sources).toEqual([
          expect.objectContaining({ source: "inference", status: "unavailable" }),
          expect.objectContaining({ source: "metadata", status: "unavailable" }),
        ]);
        expect(JSON.stringify(outage)).not.toContain(INFERENCE_KEY);
        expect(JSON.stringify(outage)).not.toContain(METADATA_KEY);
        const outageDoctor = await diagnose(
          doctorConfig(fixture.root, current, purpose, currentPolicy),
          { live: false },
        );
        expect(
          purpose === "policy" ? outageDoctor.profile : outageDoctor.judge?.profile,
        ).toMatchObject({ metadata: { status: "current" } });

        const activeBytesBeforeDrift = await readFile(resolve(fixture.root, ".env"));
        const activeSha256BeforeDrift = bytesSha256(activeBytesBeforeDrift);
        const reducedCurrentInspection = await inspect(
          current,
          purpose,
          NOW,
          reducedCatalogFetch(),
        );
        expect(field(reducedCurrentInspection, "contextWindow").drift.status).toBe("different");
        expect(proposalField(reducedCurrentInspection, "contextWindow")).toMatchObject({
          state: "observed",
          value: 64_000,
        });
        const activeBytesAfterDrift = await readFile(resolve(fixture.root, ".env"));
        expect(activeBytesAfterDrift).toEqual(activeBytesBeforeDrift);
        expect(bytesSha256(activeBytesAfterDrift)).toBe(activeSha256BeforeDrift);
        const unchangedCurrent = await loadProfileApprovalEndpoint({
          projectRoot: fixture.root,
          purpose,
          ambientEnvironment: {},
          now: NOW,
        });
        expect(unchangedCurrent.profile).toMatchObject({
          configuredLimits: {
            contextWindow: 128_000,
            maxInputTokens: 96_000,
            maxOutputTokens: 20_000,
          },
          contextWindow: 128_000,
          maxInputTokens: 96_000,
          maxOutputTokens: 20_000,
          effectiveLimitReason: "none",
          metadata: { status: "current", reviewAfter: "2026-09-01" },
        });

        const expired = await loadProfileApprovalEndpoint({
          projectRoot: fixture.root,
          purpose,
          ambientEnvironment: {},
          now: EXPIRED,
        });
        // Past its review date the approved profile is unchanged and
        // current; the date is an advisory reminder only.
        expect(EXPIRED.toISOString().slice(0, 10) > "2026-09-01").toBe(true);
        expect(expired.profile).toEqual(unchangedCurrent.profile);
        expect(expired.profile).toMatchObject({
          contextWindow: 128_000,
          maxOutputTokens: 20_000,
          effectiveLimitReason: "none",
          metadata: { status: "current", reviewAfter: "2026-09-01" },
        });

        const refreshInspection = await inspect(expired, purpose, EXPIRED, reducedCatalogFetch());
        expect(field(refreshInspection, "contextWindow").drift.status).toBe("different");
        expect(proposalField(refreshInspection, "inputPrice")).toMatchObject({ state: "unknown" });

        const refreshed = approve(refreshInspection, expired, purpose, {
          effectiveDate: "2026-09-02",
          reviewAfter: "2026-10-01",
          now: EXPIRED,
        });
        expect(refreshed.bundle.sha256).not.toBe(first.bundle.sha256);
        expect(refreshed.bundle.modelEvidence.profile?.sha256).not.toBe(
          first.bundle.modelEvidence.profile?.sha256,
        );
        expect(refreshed.bundle.approval).toMatchObject({
          effectiveDate: "2026-09-02",
          reviewAfter: "2026-10-01",
        });

        const refreshReceipt = await apply(
          fixture.root,
          purpose,
          refreshInspection,
          refreshed.bundle,
          refreshed.authority,
          resolve(fixture.privateRoot, `${purpose}-refresh-apply.json`),
          EXPIRED,
        );
        const refreshedEndpoint = await loadProfileApprovalEndpoint({
          projectRoot: fixture.root,
          purpose,
          ambientEnvironment: {},
          now: EXPIRED,
        });
        expect(refreshedEndpoint.profile).toMatchObject({
          configuredLimits: {
            contextWindow: 64_000,
            maxInputTokens: 48_000,
            maxOutputTokens: 8_000,
          },
          reasoning: false,
          effectiveLimitReason: "none",
          metadata: { status: "current", reviewAfter: "2026-10-01" },
        });

        const rollback = await prepareProfileRollback({
          projectRoot: fixture.root,
          receipt: refreshReceipt,
        });
        const rollbackReceipt = await applyProfileRollback({
          prepared: rollback,
          receipt: refreshReceipt,
          confirmRollbackSha256: rollback.preview.sha256,
          receiptPath: resolve(fixture.privateRoot, `${purpose}-refresh-rollback.json`),
          now: EXPIRED,
        });
        expect(rollbackReceipt).toMatchObject({
          kind: "docsfab-profile-rollback-receipt",
          purpose,
          applyReceiptSha256: refreshReceipt.sha256,
        });
        const rolledBack = await loadProfileApprovalEndpoint({
          projectRoot: fixture.root,
          purpose,
          ambientEnvironment: {},
          now: EXPIRED,
        });
        expect(rolledBack.profile).toMatchObject({
          configuredLimits: {
            contextWindow: 128_000,
            maxInputTokens: 96_000,
            maxOutputTokens: 20_000,
          },
          effectiveLimitReason: "none",
          metadata: { status: "current", reviewAfter: "2026-09-01" },
        });
        expect(firstReceipt.purpose).toBe(purpose);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("covers timeout, authorization, model removal, capability regression, limit reduction, and absent pricing", async () => {
    const timeout = inspectInferenceHubMetadata({
      requested: true,
      authority: "authenticated",
      purpose: "policy",
      label: QUALIFIED_MODEL_ID,
      endpoint: { origin: METADATA_ORIGIN, path: METADATA_PATH, mode: "search" },
      environment: { INFERENCE_HUB_METADATA_API_KEY: METADATA_KEY },
      fetch: (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch,
      limits: { timeoutMs: 5 },
      clock: () => NOW,
    });
    await expect(timeout).rejects.toMatchObject({ code: "request-timeout" });

    const unauthorized = inspectInferenceHubMetadata({
      requested: true,
      authority: "authenticated",
      purpose: "policy",
      label: QUALIFIED_MODEL_ID,
      endpoint: { origin: METADATA_ORIGIN, path: METADATA_PATH, mode: "search" },
      environment: { INFERENCE_HUB_METADATA_API_KEY: METADATA_KEY },
      fetch: (async (request) =>
        responseAt(String(request), { error: METADATA_KEY }, 401)) as typeof globalThis.fetch,
      clock: () => NOW,
    });
    const authorizationFailure = await unauthorized.catch((error: unknown) => error);
    expect(authorizationFailure).toBeInstanceOf(InferenceHubMetadataError);
    expect(authorizationFailure).toMatchObject({ code: "request-failed" });
    expect(String(authorizationFailure)).not.toContain(METADATA_KEY);

    const fixture = await createRoot(false);
    try {
      const endpoint = await loadProfileApprovalEndpoint({
        projectRoot: fixture.root,
        purpose: "policy",
        ambientEnvironment: {},
        now: NOW,
      });
      const removed = await inspect(endpoint, "policy", NOW, async (request) => {
        const url = String(request);
        return url.includes(new URL(HUB_BASE_URL).host)
          ? responseAt(url, { object: "list", data: [] })
          : responseAt(url, { models: [{ label: "different/model" }], next_cursor: null });
      });
      expect(removed.catalog.reconciliation).toBeNull();
      expect(removed.catalog.sources).toEqual([
        expect.objectContaining({ source: "inference", code: "model-absent" }),
        expect.objectContaining({ source: "metadata", code: "model-not-found" }),
      ]);

      const regression = await inspect(
        endpoint,
        "policy",
        NOW,
        catalogFetch({
          inferenceInput: 48_000,
          inferenceOutput: 8_000,
          metadataContext: 64_000,
          metadataInput: 56_000,
          metadataOutput: 8_000,
          reasoning: false,
          developerRole: false,
          reasoningEffort: false,
        }),
      );
      expect(proposalField(regression, "reasoning")).toMatchObject({
        state: "observed",
        value: false,
      });
      expect(proposalField(regression, "supportsDeveloperRole")).toMatchObject({
        state: "observed",
        value: false,
      });
      expect(proposalField(regression, "contextWindow")).toMatchObject({
        state: "observed",
        value: 64_000,
      });
      for (const price of [
        "inputPrice",
        "outputPrice",
        "cacheReadPrice",
        "cacheWritePrice",
      ] as const) {
        expect(proposalField(regression, price)).toMatchObject({ state: "unknown" });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not call either catalog surface during an ordinary workflow", async () => {
    const catalogFetch = vi.fn(async () => {
      throw new Error("catalog transport must remain unreachable");
    });
    vi.stubGlobal("fetch", catalogFetch);
    const harness = new AcceptanceHarness();
    const store = new MemoryStore();
    const runner = new WorkflowRunner({
      harness,
      store,
      repositoryScanner: new PassingScanner(),
      contextPreflight: readyContextPreflight,
      id: () => "catalog-acceptance-run",
      now: () => NOW,
    });
    const record = await runner.run({
      workflow: "readiness",
      workspacePath: "/tmp/docsfab-catalog-acceptance/repository",
      repository: {
        sourcePath: "/tmp/docsfab-catalog-source",
        requestedRevision: "HEAD",
        revision: "7".repeat(40),
      },
      allowWrite: false,
    });
    expect(record.status).toBe("succeeded");
    expect(harness.calls).toHaveLength(1);
    expect(catalogFetch).not.toHaveBeenCalled();
  });

  it("keeps the checked-in GPT-5.4 example bound to deterministic sanitized evidence", async () => {
    const fixture = await profileApprovalFixture();
    const exampleBytes = await readFile(
      resolve(repositoryRoot, "docs/examples/gpt-5.4-model-catalog-evidence.json"),
      "utf8",
    );
    const example = decodeSanitizedCatalogExample(parseJsonEvidence(exampleBytes));
    const reconciliation = fixture.report.catalog.reconciliation;
    if (!reconciliation?.proposal || !reconciliation.proposalProvenance) {
      throw new Error("expected deterministic proposal");
    }
    expect(example).toEqual({
      schemaVersion: 1,
      kind: "docsfab-sanitized-model-catalog-evidence-example",
      generatedAt: NOW.toISOString(),
      subject: { provider: "nvidia", model: MODEL_ID, purpose: "policy" },
      inspectionSha256: fixture.report.sha256,
      proposalSha256: reconciliation.proposal.sha256,
      proposalProvenanceSha256: reconciliation.proposalProvenance.sha256,
      decisionSha256: reconciliation.decision.sha256,
      selectedLimits: {
        contextWindow: 128_000,
        maxInputTokens: 96_000,
        maxOutputTokens: 20_000,
      },
      pricingDisposition: "unknown-not-approved",
      rawPayloadRetained: false,
      credentialsRetained: false,
      sources: fixture.report.catalog.sources.map((source) => ({
        surface: source.source,
        status: source.status,
        observationSha256: source.evidence?.observation.sha256 ?? null,
        provenanceSha256: source.evidence?.provenance.sha256 ?? null,
      })),
    });
    const serialized = JSON.stringify(example);
    expect(serialized).not.toContain(INFERENCE_KEY);
    expect(serialized).not.toContain(METADATA_KEY);
    expect(serialized).not.toContain("authorization");
    expect(detectCredentialRuleIdsInValue(example)).toEqual([]);
    expect(exampleBytes).toBe(`${JSON.stringify(example, null, 2)}\n`);
    expect(() =>
      decodeSanitizedCatalogExample({
        ...example,
        rawPayload: { providerControlled: "content" },
      }),
    ).toThrowError("Invalid sanitized model catalog example.");
    expect(() =>
      decodeSanitizedCatalogExample({
        ...example,
        subject: {
          provider: "nvidia",
          model: MODEL_ID,
          purpose: "policy",
          hostPath: "/private/operator/path",
        },
      }),
    ).toThrowError("Invalid sanitized model catalog example.");
  });
});

function decodeSanitizedCatalogExample(value: unknown) {
  const root = exactRecord(value, [
    "schemaVersion",
    "kind",
    "generatedAt",
    "subject",
    "sources",
    "inspectionSha256",
    "proposalSha256",
    "proposalProvenanceSha256",
    "decisionSha256",
    "selectedLimits",
    "pricingDisposition",
    "rawPayloadRetained",
    "credentialsRetained",
  ]);
  const subject = exactRecord(root.subject, ["provider", "model", "purpose"]);
  if (subject.provider !== "nvidia" || subject.model !== MODEL_ID || subject.purpose !== "policy")
    invalidExample();
  const sources = exactArray(root.sources);
  for (const source of sources) {
    const item = exactRecord(source, [
      "surface",
      "status",
      "observationSha256",
      "provenanceSha256",
    ]);
    if ((item.surface !== "inference" && item.surface !== "metadata") || item.status !== "observed")
      invalidExample();
    digestOrNull(item.observationSha256);
    digestOrNull(item.provenanceSha256);
  }
  const limits = exactRecord(root.selectedLimits, [
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
  ]);
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) invalidExample();
  }
  for (const field of [
    root.inspectionSha256,
    root.proposalSha256,
    root.proposalProvenanceSha256,
    root.decisionSha256,
  ])
    digestOrNull(field, false);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-sanitized-model-catalog-evidence-example" ||
    typeof root.generatedAt !== "string" ||
    root.pricingDisposition !== "unknown-not-approved" ||
    root.rawPayloadRetained !== false ||
    root.credentialsRetained !== false
  )
    invalidExample();
  return root;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    ) ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalidExample();
  return value as Record<string, unknown>;
}

function exactArray(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    ) ||
    Object.keys(value).length !== value.length ||
    Object.keys(value).some((key, index) => key !== String(index))
  )
    invalidExample();
  return value;
}

function digestOrNull(value: unknown, nullable = true): void {
  if (value === null && nullable) return;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalidExample();
}

function invalidExample(): never {
  throw new Error("Invalid sanitized model catalog example.");
}

async function createRoot(judgeEnabled: boolean): Promise<{ root: string; privateRoot: string }> {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-catalog-acceptance-")));
  await execFile("git", ["init", "--quiet"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  await writeFile(
    resolve(root, ".gitignore"),
    [
      ".env",
      ".env.docsfab-new-*",
      ".env.docsfab-rollback-*",
      ".env.docsfab-apply.lock",
      ".env.docsfab-transaction.json",
      ".env.docsfab-recovery.claim",
      "",
    ].join("\n"),
  );
  await writeFile(resolve(root, ".env"), environment(judgeEnabled), { mode: 0o600 });
  const privateRoot = resolve(root, "private");
  await mkdir(privateRoot, { mode: 0o700 });
  return { root, privateRoot };
}

function environment(judgeEnabled: boolean): string {
  const policy = endpointEnvironment("MODEL", INFERENCE_KEY);
  const judge = judgeEnabled
    ? { JUDGE_ENABLED: "true", ...endpointEnvironment("JUDGE", `nvapi-${"C".repeat(24)}`) }
    : {};
  return [...Object.entries({ ...policy, ...judge }), ["UNRELATED", "preserved"]]
    .map(([key, value]) => `${key}=${value}`)
    .concat("")
    .join("\n");
}

function endpointEnvironment(prefix: "MODEL" | "JUDGE", apiKey: string): Record<string, string> {
  return {
    [`${prefix}_PROVIDER`]: "nvidia",
    [`${prefix}_BASE_URL`]: HUB_BASE_URL,
    [prefix === "MODEL" ? "MODEL_ID" : "JUDGE_MODEL_ID"]: MODEL_ID,
    [`${prefix}_API_FORMAT`]: "chat_completions",
    [`${prefix}_API_KEY`]: apiKey,
    [`${prefix}_CONTEXT_WINDOW`]: "8192",
    [`${prefix}_MAX_INPUT_TOKENS`]: "8192",
    [`${prefix}_MAX_OUTPUT_TOKENS`]: "4096",
    [`${prefix}_API_MIN_OUTPUT_TOKENS`]: "16",
    [`${prefix}_CONTEXT_RESERVE_TOKENS`]: "4096",
    [`${prefix}_REASONING`]: "true",
    [`${prefix}_INPUT_TYPES`]: "text",
    [`${prefix}_SUPPORTS_DEVELOPER_ROLE`]: "true",
    [`${prefix}_SUPPORTS_REASONING_EFFORT`]: "true",
    [`${prefix}_COMPATIBLE_API_FORMATS`]: "chat_completions",
    [`${prefix}_INPUT_COST_PER_MILLION`]: "unknown",
    [`${prefix}_OUTPUT_COST_PER_MILLION`]: "unknown",
    [`${prefix}_CACHE_READ_COST_PER_MILLION`]: "unknown",
    [`${prefix}_CACHE_WRITE_COST_PER_MILLION`]: "unknown",
    [`${prefix}_PROFILE_APPROVED_SOURCE`]: "unknown",
    [`${prefix}_PROFILE_EFFECTIVE_DATE`]: "unknown",
    [`${prefix}_PROFILE_REVIEW_AFTER`]: "unknown",
  };
}

function catalogEnvironment(purpose: "policy" | "judge"): NodeJS.ProcessEnv {
  return {
    INFERENCE_HUB_METADATA_ORIGIN: METADATA_ORIGIN,
    INFERENCE_HUB_METADATA_PATH: METADATA_PATH,
    INFERENCE_HUB_METADATA_MODE: "search",
    INFERENCE_HUB_METADATA_API_KEY: METADATA_KEY,
    [purpose === "policy"
      ? "MODEL_INFERENCE_HUB_METADATA_LABEL"
      : "JUDGE_INFERENCE_HUB_METADATA_LABEL"]: QUALIFIED_MODEL_ID,
  };
}

function catalogFetch(
  options: {
    inferenceInput?: number;
    inferenceOutput?: number;
    metadataContext?: number;
    metadataInput?: number;
    metadataOutput?: number;
    reasoning?: boolean;
    developerRole?: boolean;
    reasoningEffort?: boolean;
  } = {},
): typeof globalThis.fetch {
  return (async (request) => {
    const url = String(request);
    if (url === `${HUB_BASE_URL}/models`) {
      return responseAt(url, {
        object: "list",
        data: [
          {
            id: MODEL_ID,
            max_input_tokens: options.inferenceInput ?? 100_000,
            max_output_tokens: options.inferenceOutput ?? 20_000,
          },
        ],
      });
    }
    return responseAt(url, {
      models: [
        {
          label: QUALIFIED_MODEL_ID,
          provider_id: "azure",
          status: "active",
          capabilities: {
            reasoning: options.reasoning ?? true,
            chat: true,
            tool_use: true,
            input_modalities: ["text"],
            supports_developer_role: options.developerRole ?? true,
            supports_reasoning_effort: options.reasoningEffort ?? true,
            supports_system_role: true,
          },
          limits: {
            context_length: options.metadataContext ?? 128_000,
            max_input_tokens: options.metadataInput ?? 96_000,
            max_output_tokens: options.metadataOutput ?? 32_000,
            limit_semantics: "combined-context",
          },
          pricing: null,
        },
      ],
      next_cursor: null,
    });
  }) as typeof globalThis.fetch;
}

function reducedCatalogFetch(): typeof globalThis.fetch {
  return catalogFetch({
    inferenceInput: 48_000,
    inferenceOutput: 8_000,
    metadataContext: 64_000,
    metadataInput: 56_000,
    metadataOutput: 8_000,
    reasoning: false,
    developerRole: false,
    reasoningEffort: false,
  });
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function responseAt(url: string, body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

async function inspect(
  endpoint: ModelEndpointConfig,
  purpose: "policy" | "judge",
  now: Date,
  fetch: typeof globalThis.fetch,
): Promise<ModelProfileInspectionV1> {
  return inspectModelEndpointProfile(endpoint, purpose, {
    catalog: true,
    environment: catalogEnvironment(purpose),
    fetch,
    clock: () => now,
  });
}

function approve(
  inspection: ModelProfileInspectionV1,
  endpoint: ModelEndpointConfig,
  purpose: "policy" | "judge",
  dates: { effectiveDate: string; reviewAfter: string; now: Date },
) {
  const proposal = inspection.catalog.reconciliation?.proposal;
  if (!proposal) throw new Error("acceptance inspection did not propose a profile");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const authority = { id: `operator:${purpose}:catalog-review`, publicKey };
  const bundle = approveModelProfile({
    inspection,
    purpose,
    proposalSha256: proposal.sha256,
    effectiveDate: dates.effectiveDate,
    reviewAfter: dates.reviewAfter,
    conflictFields: proposal.fields
      .filter((candidate) => candidate.state === "conflicting")
      .map((candidate) => candidate.field),
    authority,
    privateKey: keys.privateKey,
    endpoint,
    now: dates.now,
  });
  return { authority, bundle };
}

async function apply(
  root: string,
  purpose: "policy" | "judge",
  inspection: ModelProfileInspectionV1,
  bundle: ReturnType<typeof approveModelProfile>,
  authority: { id: string; publicKey: string },
  receiptPath: string,
  now: Date,
) {
  const prepared = await prepareProfileApply({
    projectRoot: root,
    purpose,
    inspection,
    approvalBundle: bundle,
    authority,
    ambientEnvironment: {},
    now,
  });
  return applyProfileConfiguration({
    prepared,
    confirmPatchSha256: prepared.preview.patch.sha256,
    inspection,
    approvalBundle: bundle,
    authority,
    ambientEnvironment: {},
    now,
    receiptPath,
  });
}

function doctorConfig(
  root: string,
  selected: ModelEndpointConfig,
  purpose: "policy" | "judge",
  policy?: ModelEndpointConfig,
): DocsFabConfig {
  return {
    projectRoot: root,
    skillCrateDirectory: resolve(repositoryRoot, "skill-crate"),
    qualityDirectory: resolve(repositoryRoot, "quality"),
    qualityPackDirectory: resolve(repositoryRoot, "quality-pack"),
    stateDirectory: resolve(root, ".docsfab"),
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      retryableCategories: ["timeout", "provider-transient"],
    },
    model: purpose === "policy" ? selected : policy!,
    ...(purpose === "judge" ? { judge: selected } : {}),
  };
}

function field(report: ModelProfileInspectionV1, name: string) {
  const result = report.fields.find((candidate) => candidate.field === name);
  if (!result) throw new Error(`missing inspection field ${name}`);
  return result;
}

function proposalField(report: ModelProfileInspectionV1, name: string) {
  const result = report.catalog.reconciliation?.proposal?.fields.find(
    (candidate) => candidate.field === name,
  );
  if (!result) throw new Error(`missing proposal field ${name}`);
  return result;
}

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class PassingScanner implements RepositorySecurityScanner {
  public async scan(): Promise<SecurityScanReport> {
    return {
      ruleSet: "catalog-acceptance-v1",
      status: "passed",
      scannedFiles: 0,
      binaryFiles: 0,
      findings: [],
    };
  }
}

class AcceptanceHarness implements AgentHarness {
  public calls: HarnessStepInput[] = [];

  public async runStep(input: HarnessStepInput) {
    this.calls.push(input);
    return {
      summary: "ordinary governed inference completed",
      model: { provider: "fixture", model: "offline" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
        turns: 1,
      },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    };
  }
}
