// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isOnlyUnsupportedApiFormatIssue,
  parseDoctorArguments,
  parseProfileInspectionArguments,
} from "../src/cli.js";
import {
  ModelProfileMigrationError,
  parseModelEndpoint,
  type ModelEndpointConfig,
} from "../src/model/configuration.js";
import {
  loadModelEndpointForInspection,
  type DocsFabConfig,
} from "../src/config/runtime-loader.js";
import {
  decodeModelProfileInspection,
  formatModelProfileInspection,
  formatModelProfileInspectionDetailed,
  inspectModelEndpointProfile,
  inspectModelProfile,
  serializeModelProfileInspection,
  serializeModelProfileInspectionPreflight,
  type ModelProfileInspectionV1,
  unsupportedApiFormatInspection,
} from "../src/model/profile-inspection.js";
import { NVIDIA_INFERENCE_CATALOG_ENDPOINT } from "../src/model/nvidia-inference-catalog.js";
import {
  OUTBOUND_PROXY_INVALID_CODE,
  OutboundProxyRefusal,
  resetOutboundProxyStateForTests,
} from "../src/model/outbound-http-policy.js";
import { validModelConfig } from "./helpers.js";
import { validModelEnvironment } from "./helpers.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { finalizeModelCatalogObservation } from "../src/model/catalog-contracts.js";
import { finalizeModelCatalogObservationProvenance } from "../src/model/catalog-provenance.js";
import { reconcileModelCatalog } from "../src/model/catalog-reconciliation.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const NOW = new Date("2026-08-04T12:34:56.789Z");
const INFERENCE_KEY = `nvapi-${"A".repeat(24)}`;
const METADATA_KEY = `ihub_api_${"B".repeat(24)}`;

function configuration(model: ModelEndpointConfig = validModelConfig): DocsFabConfig {
  return {
    projectRoot: "/private/host/repository",
    skillCrateDirectory: "/private/host/skill-crate",
    qualityDirectory: "/private/host/quality",
    qualityPackDirectory: "/private/host/quality-pack",
    stateDirectory: "/private/host/state",
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableCategories: ["provider-transient"],
    },
    model,
  };
}

function unknownEndpoint(overrides: Partial<ModelEndpointConfig> = {}): ModelEndpointConfig {
  return {
    ...validModelConfig,
    ...overrides,
    profile: {
      ...validModelConfig.profile,
      configuredLimits: { ...validModelConfig.profile.configuredLimits },
      contextWindow: 8_192,
      maxInputTokens: 8_192,
      maxOutputTokens: 4_096,
      effectiveLimitReason: "metadata-unknown",
      reasoning: false,
      input: ["text"],
      compatibility: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        apiFormats: ["chat_completions"],
      },
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      metadata: { approvedSource: null, effectiveDate: null, reviewAfter: null, status: "unknown" },
    },
  };
}

function inferenceEndpoint(modelId = "openai/gpt-5.4"): ModelEndpointConfig {
  return unknownEndpoint({
    providerId: "nvidia",
    modelId,
    baseUrl: HUB_BASE_URL,
    apiKey: INFERENCE_KEY,
  });
}

describe("model profile inspection", () => {
  it("routes non-monotonic inspection time to host-clock recovery", async () => {
    const times = [new Date("2026-10-08T12:00:00.000Z"), new Date("2026-10-08T11:59:59.000Z")];
    let failure: unknown;
    try {
      await inspectModelEndpointProfile(inferenceEndpoint(), "policy", {
        catalog: true,
        environment: {},
        fetch: (async () =>
          responseAt(NVIDIA_INFERENCE_CATALOG_ENDPOINT, {
            object: "list",
            data: [{ id: "openai/gpt-5.4" }],
          })) as typeof globalThis.fetch,
        clock: () => times.shift()!,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(times).toHaveLength(0);
    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("profile-inspection-clock-invalid");
    expect(envelope.nextAction).toContain("host clock or time synchronization");
    expect(envelope.nextAction).not.toMatch(/docsfab profile inspect|docsfab profile approve/u);
  });

  it("classifies an invalid preflight clock through the same typed recovery", () => {
    let failure: unknown;
    try {
      unsupportedApiFormatInspection("policy", () => new Date(Number.NaN));
    } catch (error) {
      failure = error;
    }

    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("profile-inspection-clock-invalid");
    expect(envelope.nextAction).toContain("host clock or time synchronization");
    expect(envelope.nextAction).not.toMatch(/docsfab profile inspect|docsfab profile approve/u);
  });

  it("produces deterministic human and canonical JSON snapshots for current configuration", async () => {
    const report = await inspectModelProfile(configuration(), { clock: () => NOW });

    expect(formatModelProfileInspection(report)).toMatchInlineSnapshot(`
      "DocsFab model profile

      This command shows which model DocsFab will use and the token limits currently in effect.
      It does not call the model.

      Status: Ready
      Model: example/model
      Provider: test-provider
      Use: Documentation workflows
      Token limits: 128,000 input; 16,384 output; 128,000 total context

      The profile metadata is current. DocsFab will use the configured token limits.
      Provider check: Not run. Only the local configuration was inspected.
      Next step: No action is required for ordinary local use.

      Optional checks:
        Compare with provider metadata: docsfab profile inspect --catalog
        Show technical evidence: docsfab profile inspect --verbose
        Print JSON evidence: docsfab profile inspect --json"
    `);
    expect(serializeModelProfileInspection(report)).toMatchSnapshot();
    expect(formatModelProfileInspectionDetailed(report)).toMatchInlineSnapshot(`
      "DocsFab model profile inspection v1 (policy)
      Subject: test-provider/example/model
      Runtime: current; fallback=inactive; verified-approval=unknown
      Configured claim: freshness=current; source-digest=7596b67ed554ce5ed75d0064a0f68191d02d09c6a03569942d37ca45a098a25b; verification=not-performed
      Limits: context=128000, input=128000, output=16384
      Catalog: requested=false; inference=not-requested; metadata=not-requested
      Reconciliation: unavailable
      Drift:
        activity: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
        billingInterpretation: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
        cacheWritePrice: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
        limitSemantics: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
        origin: configured=redacted, effective=redacted, observed=none, proposed=redacted, approved=unknown [no-authoritative-value,approval-unverified]
        providerCreatedAt: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
        providerUpdatedAt: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
        supportsSystemRole: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
        toolUse: configured=unknown, effective=unknown, observed=none, proposed=unknown, approved=unknown [no-authoritative-value,approval-unverified]
      Reasons: catalog-not-requested, legacy-config-is-not-approval, verified-approval-unavailable
      Remediation:
        - Run \`docsfab profile inspect --catalog\` for explicit read-only provider discovery.
        - Complete the governed proposal and approval chain; legacy environment configuration is not approval.
      Evidence SHA-256: 23247ecb01c1bcfdbcfbf0bb20869aed4dc9c0b897ae590027e68913f949eecf"
    `);
    expect(
      report.fields.every(
        (field) =>
          field.approved.state === "unknown" &&
          field.approved.reason === "no-verified-approval-evidence",
      ),
    ).toBe(true);
  });

  it.each([
    ["unknown", unknownEndpoint(), "fallback-metadata-unknown"],
    [
      "stale",
      {
        ...unknownEndpoint(),
        profile: {
          ...unknownEndpoint().profile,
          effectiveLimitReason: "metadata-stale" as const,
          metadata: {
            approvedSource: "https://configured.example.test/model",
            effectiveDate: "2020-01-01",
            reviewAfter: "2020-02-01",
            status: "stale" as const,
          },
        },
      },
      "fallback-metadata-stale",
    ],
  ] as const)(
    "keeps %s configuration conservative and unapproved",
    async (_name, endpoint, reason) => {
      const report = await inspectModelProfile(configuration(endpoint), { clock: () => NOW });
      const human = formatModelProfileInspection(report);
      expect(report.runtime).toMatchObject({ fallbackApplied: true, verifiedApproval: "unknown" });
      expect(report.reasons).toContain(reason);
      expect(report.fields.find((item) => item.field === "contextWindow")?.effective).toEqual({
        state: "known",
        value: 8_192,
      });
      expect(report.fields.find((item) => item.field === "maxOutputTokens")?.effective).toEqual({
        state: "known",
        value: 4_096,
      });
      expect(human).toContain(
        _name === "unknown"
          ? "Status: Ready without a DocsFab host context ceiling"
          : "Status: Needs attention",
      );
      expect(human).toContain(
        _name === "unknown"
          ? "No action is required for local testing"
          : "Next step: The profile review date has passed. To re-inspect, run `docsfab profile inspect --catalog --json`",
      );
      expect(human).not.toContain("verified-approval=unknown");
      expect(snapshotSummary(report)).toMatchSnapshot(_name);
    },
  );

  describe("review-overdue advisory", () => {
    const overdueLine = (reviewAfter: string) =>
      `Review overdue: the profile review date ${reviewAfter} has passed. This is a reminder only; DocsFab still uses the configured limits, capabilities, and prices.`;
    const endpointReviewing = (reviewAfter: string) =>
      parseModelEndpoint(
        { ...validModelEnvironment, MODEL_PROFILE_REVIEW_AFTER: reviewAfter },
        "MODEL",
        NOW,
      );

    it("reports a profile past its review date as ready and current, with the advisory", async () => {
      const reviewAfter = "2026-08-03";
      expect(reviewAfter < NOW.toISOString().slice(0, 10)).toBe(true);
      const report = await inspectModelProfile(configuration(endpointReviewing(reviewAfter)), {
        clock: () => NOW,
      });
      const human = formatModelProfileInspection(report);

      expect(report.runtime).toMatchObject({
        profileStatus: "current",
        effectiveLimitReason: "none",
        fallbackApplied: false,
      });
      expect(report.reasons).not.toContain("fallback-metadata-stale");
      expect(human).toContain("Status: Ready");
      expect(human).toContain(
        "The profile metadata is current. DocsFab will use the configured token limits.",
      );
      expect(human.split("\n").filter((line) => line.startsWith("Review overdue"))).toEqual([
        overdueLine(reviewAfter),
      ]);
      const verbose = formatModelProfileInspectionDetailed(report);
      expect(verbose.split("\n").filter((line) => line.startsWith("Review overdue"))).toEqual([
        overdueLine(reviewAfter),
      ]);
      // The advisory is read from the report's own clock, not stored in it.
      expect(serializeModelProfileInspection(report)).not.toContain("overdue");
    });

    it("prints no advisory on the review date itself", async () => {
      // Adjacent condition: the report is generated during the review day.
      const reviewAfter = NOW.toISOString().slice(0, 10);
      const report = await inspectModelProfile(configuration(endpointReviewing(reviewAfter)), {
        clock: () => NOW,
      });
      expect(formatModelProfileInspection(report)).not.toContain("Review overdue");
      expect(formatModelProfileInspectionDetailed(report)).not.toContain("Review overdue");
    });

    it("prints no advisory for unknown metadata", async () => {
      // Adjacent condition: no attested review date.
      const report = await inspectModelProfile(configuration(unknownEndpoint()), {
        clock: () => NOW,
      });
      expect(formatModelProfileInspection(report)).not.toContain("Review overdue");
    });
  });

  it("does not touch environment, fetch, config, or filesystem in offline mode", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "docsfab-profile-inspect-"));
    const canaryPath = resolve(root, "canary");
    await writeFile(canaryPath, "unchanged");
    const endpoint = unknownEndpoint();
    const before = structuredClone(endpoint);
    const fetch = vi.fn(() => {
      throw new Error("offline fetch poison");
    });
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      getOwnPropertyDescriptor: () => {
        throw new Error("offline environment poison");
      },
    });
    try {
      await inspectModelProfile(
        { ...configuration(endpoint), projectRoot: root },
        {
          environment,
          fetch,
          clock: () => NOW,
        },
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(endpoint).toEqual(before);
      expect(await readFile(canaryPath, "utf8")).toBe("unchanged");
      expect(await readdir(root)).toEqual(["canary"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains inference evidence when the Metadata credential is missing", async () => {
    const endpoint = inferenceEndpoint();
    const fetch = vi.fn(async (request: string | URL | Request) => {
      expect(String(request)).toBe(NVIDIA_INFERENCE_CATALOG_ENDPOINT);
      return responseAt(NVIDIA_INFERENCE_CATALOG_ENDPOINT, {
        object: "list",
        data: [{ id: endpoint.modelId, max_input_tokens: 100_000, max_output_tokens: 20_000 }],
      });
    });
    const report = await inspectModelProfile(configuration(endpoint), {
      catalog: true,
      environment: {
        INFERENCE_HUB_METADATA_ORIGIN: "https://metadata.example.test",
        INFERENCE_HUB_METADATA_PATH: "/v1/catalog/search",
        INFERENCE_HUB_METADATA_MODE: "search",
        MODEL_INFERENCE_HUB_METADATA_LABEL: "azure/openai/gpt-5.4",
      },
      fetch: fetch as typeof globalThis.fetch,
      clock: () => NOW,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report.catalog.sources).toMatchObject([
      { source: "inference", status: "observed" },
      { source: "metadata", status: "unavailable", code: "metadata-api-key-missing" },
    ]);
    expect(report.catalog.reconciliation?.decision.disposition).toBe("blocked");
  });

  it("records authentic retrieval time before inspection completion", async () => {
    const times = [new Date("2026-08-04T12:34:56.000Z"), new Date("2026-08-04T12:34:57.000Z")];
    const report = await inspectModelProfile(configuration(inferenceEndpoint()), {
      catalog: true,
      environment: {},
      fetch: (async () =>
        responseAt(NVIDIA_INFERENCE_CATALOG_ENDPOINT, {
          object: "list",
          data: [{ id: "openai/gpt-5.4" }],
        })) as typeof globalThis.fetch,
      clock: () => times.shift()!,
    });
    expect(report.catalog.sources[0]?.evidence?.observation.source.retrievedAt).toBe(
      "2026-08-04T12:34:56.000Z",
    );
    expect(report.generatedAt).toBe("2026-08-04T12:34:57.000Z");
  });

  it("retains successful two-source conflicts and the selected proposal value", async () => {
    const endpoint = inferenceEndpoint();
    const fetch = vi.fn(async (request: string | URL | Request) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url === NVIDIA_INFERENCE_CATALOG_ENDPOINT) {
        return responseAt(url, {
          object: "list",
          data: [{ id: endpoint.modelId, max_input_tokens: 100_000, max_output_tokens: 20_000 }],
        });
      }
      return responseAt(url, {
        models: [
          {
            label: "azure/openai/gpt-5.4",
            provider_id: "azure",
            status: "active",
            capabilities: {
              reasoning: true,
              chat: true,
              tool_use: true,
              input_modalities: ["text"],
              supports_developer_role: true,
              supports_reasoning_effort: true,
              supports_system_role: true,
            },
            limits: {
              context_length: 128_000,
              max_input_tokens: 96_000,
              max_output_tokens: 32_000,
              limit_semantics: "combined-context",
            },
            pricing: null,
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
            description: "raw provider prose must disappear",
          },
        ],
        next_cursor: null,
      });
    });
    const report = await inspectModelProfile(configuration(endpoint), {
      catalog: true,
      environment: metadataEnvironment("policy"),
      fetch: fetch as typeof globalThis.fetch,
      clock: () => NOW,
    });
    const maxInput = report.fields.find((item) => item.field === "maxInputTokens")!;
    expect(report.catalog.sources.map((item) => item.status)).toEqual(["observed", "observed"]);
    expect(maxInput.observed.map((item) => item.evidence)).toEqual([
      { state: "known", value: 100_000 },
      { state: "known", value: 96_000 },
    ]);
    expect(maxInput.proposed).toMatchObject({ selected: 96_000, state: "conflicting" });
    expect(formatModelProfileInspectionDetailed(report)).toContain(
      "observed=inference:100000|metadata:96000",
    );
    expect(formatModelProfileInspectionDetailed(report)).toContain(
      `Proposal evidence: proposal-sha256=${report.catalog.reconciliation?.proposal?.sha256}; proposal-provenance-sha256=${report.catalog.reconciliation?.proposalProvenance?.sha256}; decision-sha256=${report.catalog.reconciliation?.decision.sha256}`,
    );
    expect(formatModelProfileInspection(report)).toContain(
      "Provider check: Inference catalog available; metadata catalog available.",
    );
    expect(formatModelProfileInspection(report)).toContain("Catalog result: Review required.");
    expect(formatModelProfileInspection(report)).not.toContain("Drift:");
    for (const mutate of [
      (value: ModelProfileInspectionV1) => {
        const row = value.fields.find((item) => item.field === "maxInputTokens")!;
        row.proposed = { state: "known", value: 999_999 };
      },
      (value: ModelProfileInspectionV1) => {
        const row = value.fields.find((item) => item.field === "maxInputTokens")!;
        row.drift = { status: "aligned", reasons: ["approval-unverified"] };
      },
      (value: ModelProfileInspectionV1) => {
        const row = value.fields.find((item) => item.field === "maxInputTokens")!;
        row.observed.push(structuredClone(row.observed[0]!));
      },
      (value: ModelProfileInspectionV1) => {
        value.reasons = ["verified-approval-unavailable"];
      },
      (value: ModelProfileInspectionV1) => {
        value.remediation = [];
      },
    ]) {
      const forged = JSON.parse(JSON.stringify(report)) as ModelProfileInspectionV1;
      mutate(forged);
      forged.sha256 = reportDigest(forged);
      expect(() => serializeModelProfileInspection(forged)).toThrow("invalid or tampered");
    }
    expect(JSON.stringify(report)).not.toContain("raw provider prose");
    expect(snapshotSummary(report)).toMatchSnapshot("conflicting");
  });

  it("retains Metadata-only partial evidence when inference fails", async () => {
    const endpoint = { ...inferenceEndpoint(), apiKey: "invalid-inference-key" };
    const fetch = vi.fn(async (request: string | URL | Request) => {
      const url = request instanceof Request ? request.url : String(request);
      return responseAt(url, {
        models: [
          {
            label: "azure/openai/gpt-5.4",
            provider_id: "azure",
            status: "active",
            capabilities: { reasoning: true, chat: true, input_modalities: ["text"] },
            limits: { context_length: 128_000, max_output_tokens: 32_000 },
            pricing: null,
          },
        ],
        next_cursor: null,
      });
    });
    const report = await inspectModelProfile(configuration(endpoint), {
      catalog: true,
      environment: metadataEnvironment("policy"),
      fetch: fetch as typeof globalThis.fetch,
      clock: () => NOW,
    });
    expect(report.catalog.sources).toMatchObject([
      { source: "inference", status: "unavailable", code: "invalid-configuration" },
      { source: "metadata", status: "observed" },
    ]);
    expect(report.catalog.reconciliation?.decision.disposition).toBe("blocked");
  });

  it("isolates policy and judge slots before network I/O", async () => {
    const policy = inferenceEndpoint("openai/policy-model");
    const judge = { ...inferenceEndpoint(), apiKey: `nvapi-${"C".repeat(24)}` };
    const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url !== NVIDIA_INFERENCE_CATALOG_ENDPOINT) {
        return responseAt(url, {
          models: [
            {
              label: "azure/openai/gpt-5.4",
              provider_id: "azure",
              status: "active",
              capabilities: { chat: true, input_modalities: ["text"] },
              limits: { context_length: 128_000 },
              pricing: null,
            },
          ],
          next_cursor: null,
        });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      const model = authorization?.includes("C") ? judge.modelId : policy.modelId;
      return responseAt(url, { object: "list", data: [{ id: model }] });
    });
    const config = { ...configuration(policy), judge };
    const report = await inspectModelProfile(config, {
      purpose: "judge",
      catalog: true,
      environment: metadataEnvironment("judge"),
      fetch: fetch as typeof globalThis.fetch,
      clock: () => NOW,
    });
    expect(report.subject.model).toBe(judge.modelId);
    expect(JSON.stringify(report)).not.toContain(policy.modelId);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(report.catalog.sources.map((item) => item.status)).toEqual(["observed", "observed"]);
    expect(snapshotSummary(report)).toMatchSnapshot("judge");
  });

  it("rejects a disabled judge before environment or network access", async () => {
    const fetch = vi.fn();
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      getOwnPropertyDescriptor: () => {
        throw new Error("must not read");
      },
    });
    await expect(
      inspectModelProfile(configuration(), {
        purpose: "judge",
        catalog: true,
        environment,
        fetch,
        clock: () => NOW,
      }),
    ).rejects.toThrow("JUDGE_ENABLED=true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports independent source outages without provider details", async () => {
    const canary = "raw-provider-outage-detail";
    const report = await inspectModelProfile(configuration(inferenceEndpoint()), {
      catalog: true,
      environment: new Proxy({} as NodeJS.ProcessEnv, {
        getOwnPropertyDescriptor: () => {
          throw new Error(canary);
        },
      }),
      fetch: (async () => {
        throw new Error(canary);
      }) as typeof globalThis.fetch,
      clock: () => NOW,
    });
    expect(report.catalog.sources).toMatchObject([
      { source: "inference", status: "unavailable", code: "network-failure" },
      { source: "metadata", status: "unavailable", code: "metadata-configuration-invalid" },
    ]);
    expect(JSON.stringify(report)).not.toContain(canary);
    expect(snapshotSummary(report)).toMatchSnapshot("unavailable");
  });

  it("excludes credential-bearing endpoints, source claims, keys, and host paths", async () => {
    const apiCanary = `nvapi-${"Z".repeat(24)}`;
    const endpoint = {
      ...unknownEndpoint(),
      baseUrl: `https://${apiCanary}@private.example.test/secret-path?token=${apiCanary}`,
      apiKey: apiCanary,
      profile: {
        ...unknownEndpoint().profile,
        effectiveLimitReason: "metadata-stale" as const,
        metadata: {
          approvedSource: `https://private.example.test/${apiCanary}`,
          effectiveDate: "2020-01-01",
          reviewAfter: "2020-01-02",
          status: "stale" as const,
        },
      },
    };
    const report = await inspectModelProfile(configuration(endpoint), { clock: () => NOW });
    const durable = serializeModelProfileInspection(report);
    expect(durable).not.toContain(apiCanary);
    expect(durable).not.toContain("private.example.test");
    expect(durable).not.toContain("/private/host");
  });

  it("rejects tampered, extended, accessor, and sparse reports before output", async () => {
    const report = await inspectModelProfile(configuration(), { clock: () => NOW });
    const mutations: Array<(value: ModelProfileInspectionV1) => void> = [
      (value) => {
        value.sha256 = "0".repeat(64);
      },
      (value) => {
        (value as unknown as Record<string, unknown>).extra = true;
      },
      (value) => {
        delete (value as unknown as Record<string, unknown>).reasons;
      },
      (value) => {
        Object.defineProperty(value, "kind", {
          get: () => "docsfab-model-profile-inspection",
          enumerable: true,
        });
      },
      (value) => {
        delete value.fields[0];
      },
    ];
    for (const mutate of mutations) {
      const candidate = JSON.parse(JSON.stringify(report)) as ModelProfileInspectionV1;
      mutate(candidate);
      expect(() => serializeModelProfileInspection(candidate)).toThrow("invalid or tampered");
      expect(() => formatModelProfileInspection(candidate)).toThrow("invalid or tampered");
      expect(() => formatModelProfileInspectionDetailed(candidate)).toThrow("invalid or tampered");
    }
    expect(decodeModelProfileInspection(serializeModelProfileInspection(report))).toEqual(report);
  });

  it("rejects rehashed semantic forgeries and exotic object keys", async () => {
    const report = await inspectModelProfile(configuration(), { clock: () => NOW });
    const forged = JSON.parse(JSON.stringify(report)) as ModelProfileInspectionV1;
    const context = forged.fields.find((item) => item.field === "contextWindow")!;
    (context.effective as unknown as { state: string; value: unknown }).value = "not-a-limit";
    forged.sha256 = reportDigest(forged);
    expect(() => serializeModelProfileInspection(forged)).toThrow("invalid or tampered");

    const fallbackReport = await inspectModelProfile(configuration(unknownEndpoint()), {
      clock: () => NOW,
    });
    const raisedFallback = JSON.parse(JSON.stringify(fallbackReport)) as ModelProfileInspectionV1;
    const fallbackContext = raisedFallback.fields.find((item) => item.field === "contextWindow")!;
    (fallbackContext.effective as { state: "known"; value: number }).value = 9_000;
    raisedFallback.sha256 = reportDigest(raisedFallback);
    expect(() => serializeModelProfileInspection(raisedFallback)).toThrow("invalid or tampered");

    const reasoningMismatch = JSON.parse(JSON.stringify(report)) as ModelProfileInspectionV1;
    const reasoning = reasoningMismatch.fields.find((item) => item.field === "reasoning")!;
    reasoning.configured = { state: "known", value: false };
    reasoningMismatch.sha256 = reportDigest(reasoningMismatch);
    expect(() => serializeModelProfileInspection(reasoningMismatch)).toThrow("invalid or tampered");

    const symbolExtended = JSON.parse(JSON.stringify(report)) as ModelProfileInspectionV1;
    Object.defineProperty(symbolExtended, Symbol("hidden"), { value: true });
    expect(() => serializeModelProfileInspection(symbolExtended)).toThrow("invalid or tampered");

    const nonEnumerable = JSON.parse(JSON.stringify(report)) as ModelProfileInspectionV1;
    Object.defineProperty(nonEnumerable.fields, "hidden", { value: true });
    expect(() => serializeModelProfileInspection(nonEnumerable)).toThrow("invalid or tampered");

    const hostPath = JSON.parse(JSON.stringify(report)) as ModelProfileInspectionV1;
    hostPath.subject.model = "/private/host/secret-model";
    hostPath.sha256 = reportDigest(hostPath);
    expect(() => serializeModelProfileInspection(hostPath)).toThrow("invalid or tampered");

    const catalogReport = await inspectModelProfile(configuration(inferenceEndpoint()), {
      catalog: true,
      environment: {},
      fetch: (async () =>
        responseAt(NVIDIA_INFERENCE_CATALOG_ENDPOINT, {
          object: "list",
          data: [{ id: "openai/gpt-5.4" }],
        })) as typeof globalThis.fetch,
      clock: () => NOW,
    });
    for (const mutate of [
      (value: ModelProfileInspectionV1) => {
        value.catalog.sources[0]!.evidence!.observation.sha256 = "1".repeat(64);
      },
      (value: ModelProfileInspectionV1) => {
        value.catalog.sources[0]!.evidence!.provenance.sha256 = "2".repeat(64);
      },
      (value: ModelProfileInspectionV1) => {
        value.catalog.reconciliation!.decision.sha256 = "3".repeat(64);
      },
    ]) {
      const forgedBinding = JSON.parse(JSON.stringify(catalogReport)) as ModelProfileInspectionV1;
      mutate(forgedBinding);
      forgedBinding.sha256 = reportDigest(forgedBinding);
      expect(() => serializeModelProfileInspection(forgedBinding)).toThrow("invalid or tampered");
    }
    const rawAdapter = JSON.parse(JSON.stringify(catalogReport)) as ModelProfileInspectionV1;
    rawAdapter.catalog.sources[0]!.evidence!.observation.source.adapter.id =
      "/private/host/adapter";
    rawAdapter.sha256 = reportDigest(rawAdapter);
    expect(() => serializeModelProfileInspection(rawAdapter)).toThrow("invalid or tampered");
    const selfConsistentEvil = JSON.parse(
      JSON.stringify(catalogReport),
    ) as ModelProfileInspectionV1;
    const originalEvidence = selfConsistentEvil.catalog.sources[0]!.evidence!;
    const evilObservation = finalizeModelCatalogObservation({
      id: originalEvidence.observation.id,
      purpose: "policy",
      source: {
        ...originalEvidence.observation.source,
        id: "evil-source",
        adapter: { id: "adapter:evil-source", version: "1.0.0" },
      },
      fields: originalEvidence.observation.fields,
    });
    const evilProvenance = finalizeModelCatalogObservationProvenance({
      observation: evilObservation,
      sourcePath: "/v1/models",
    });
    selfConsistentEvil.catalog.sources[0]!.evidence = {
      observation: evilObservation,
      provenance: evilProvenance,
    };
    const reconciliationInput = selfConsistentEvil.catalog.reconciliation!.input;
    const evilReconciliation = reconcileModelCatalog({
      purpose: "policy",
      ...reconciliationInput,
      observations: [evilObservation],
      observationProvenance: [evilProvenance],
    });
    selfConsistentEvil.catalog.reconciliation = {
      status: evilReconciliation.status,
      input: reconciliationInput,
      observationSet: evilReconciliation.observationSet,
      proposal: evilReconciliation.status === "proposed" ? evilReconciliation.proposal : null,
      proposalProvenance:
        evilReconciliation.status === "proposed" ? evilReconciliation.proposalProvenance : null,
      decision: evilReconciliation.decision,
    };
    for (const row of selfConsistentEvil.fields) {
      row.observed[0]!.observationSha256 = evilObservation.sha256;
      row.observed[0]!.provenanceSha256 = evilProvenance.sha256;
    }
    selfConsistentEvil.sha256 = reportDigest(selfConsistentEvil);
    expect(() => serializeModelProfileInspection(selfConsistentEvil)).toThrow(
      "invalid or tampered",
    );
    const missingReconciliation = JSON.parse(
      JSON.stringify(catalogReport),
    ) as ModelProfileInspectionV1;
    missingReconciliation.catalog.reconciliation = null;
    missingReconciliation.sha256 = reportDigest(missingReconciliation);
    expect(() => serializeModelProfileInspection(missingReconciliation)).toThrow(
      "invalid or tampered",
    );

    const regeneratedReport = await inspectModelProfile(configuration(inferenceEndpoint()), {
      catalog: true,
      environment: {},
      fetch: (async () =>
        responseAt(NVIDIA_INFERENCE_CATALOG_ENDPOINT, {
          object: "list",
          data: [{ id: "openai/gpt-5.4", max_input_tokens: 99_000 }],
        })) as typeof globalThis.fetch,
      clock: () => NOW,
    });
    const staleIds = catalogReport.catalog.reconciliation!.input;
    const regeneratedEvidence = regeneratedReport.catalog.sources[0]!.evidence!;
    const staleReconciliation = reconcileModelCatalog({
      purpose: "policy",
      ...staleIds,
      observations: [regeneratedEvidence.observation],
      observationProvenance: [regeneratedEvidence.provenance],
    });
    const staleIdReport = JSON.parse(JSON.stringify(regeneratedReport)) as ModelProfileInspectionV1;
    staleIdReport.catalog.reconciliation = {
      status: staleReconciliation.status,
      input: staleIds,
      observationSet: staleReconciliation.observationSet,
      proposal: staleReconciliation.status === "proposed" ? staleReconciliation.proposal : null,
      proposalProvenance:
        staleReconciliation.status === "proposed" ? staleReconciliation.proposalProvenance : null,
      decision: staleReconciliation.decision,
    };
    staleIdReport.sha256 = reportDigest(staleIdReport);
    expect(() => serializeModelProfileInspection(staleIdReport)).toThrow("invalid or tampered");
  });

  it("keeps unsupported API format errors typed and content-free before adapters", () => {
    const canary = `nvapi-${"Q".repeat(24)}`;
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_API_KEY: canary,
        MODEL_API_FORMAT: "unsupported-provider-format",
      }),
    ).toThrow("MODEL_API_FORMAT");
    try {
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_API_KEY: canary,
        MODEL_API_FORMAT: "unsupported-provider-format",
      });
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
    const report = unsupportedApiFormatInspection("policy", () => NOW);
    expect(report).toMatchObject({
      kind: "docsfab-model-profile-inspection-preflight",
      apiDisposition: "unsupported",
      reason: "unsupported-api-format",
      field: "MODEL_API_FORMAT",
    });
    expect(serializeModelProfileInspectionPreflight(report)).not.toContain(canary);
    const exact = new ModelProfileMigrationError([
      {
        profile: "MODEL",
        field: "MODEL_API_FORMAT",
        message: "configured value is incompatible",
      },
    ]);
    const mixed = new ModelProfileMigrationError([
      { profile: "MODEL", field: "MODEL_API_FORMAT", message: "configured value is incompatible" },
      { profile: "MODEL", field: "MODEL_CONTEXT_WINDOW", message: "must be positive" },
    ]);
    const crossProfileMixed = new ModelProfileMigrationError([
      { profile: "MODEL", field: "MODEL_API_FORMAT", message: "configured value is incompatible" },
      { profile: "JUDGE", field: "JUDGE_CONTEXT_WINDOW", message: "must be positive" },
    ]);
    expect(isOnlyUnsupportedApiFormatIssue(exact, "policy")).toBe(true);
    expect(isOnlyUnsupportedApiFormatIssue(mixed, "policy")).toBe(false);
    expect(isOnlyUnsupportedApiFormatIssue(crossProfileMixed, "policy")).toBe(false);
  });

  it("loads policy and judge inspection slots independently", () => {
    try {
      for (const [key, value] of Object.entries(validModelEnvironment)) vi.stubEnv(key, value);
      vi.stubEnv("JUDGE_ENABLED", "true");
      vi.stubEnv("JUDGE_API_FORMAT", "unsupported-cross-slot-value");
      expect(loadModelEndpointForInspection("policy").modelId).toBe("example/model");

      for (const [key, value] of Object.entries(validModelEnvironment)) {
        vi.stubEnv(
          key === "MODEL_ID" ? "JUDGE_MODEL_ID" : key.replace(/^MODEL_/u, "JUDGE_"),
          value,
        );
      }
      vi.stubEnv("MODEL_API_FORMAT", "unsupported-cross-slot-value");
      expect(loadModelEndpointForInspection("judge").modelId).toBe("example/model");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("profile inspection with a proxy refusal on the metadata host only", () => {
  const PROXY_VARIABLES = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const;
  const METADATA_ORIGIN = metadataEnvironment("policy").INFERENCE_HUB_METADATA_ORIGIN!;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetOutboundProxyStateForTests();
  });

  /**
   * The inference host bypasses an invalid proxy setting through NO_PROXY, so
   * its catalog is fetched and observed; the metadata host is refused by the
   * shipped default fetch. Global fetch answers the inference catalog only.
   */
  function mixedRoute(noProxy: string, metadata: (url: string) => Response) {
    for (const name of PROXY_VARIABLES) vi.stubEnv(name, undefined);
    vi.stubEnv("HTTPS_PROXY", "socks5://h:1");
    vi.stubEnv("NO_PROXY", noProxy);
    resetOutboundProxyStateForTests();
    const endpoint = inferenceEndpoint();
    const send = vi.fn(async (request: string | URL | Request) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url === NVIDIA_INFERENCE_CATALOG_ENDPOINT) {
        return responseAt(url, {
          object: "list",
          data: [{ id: endpoint.modelId, max_input_tokens: 100_000, max_output_tokens: 20_000 }],
        });
      }
      if (url.startsWith(METADATA_ORIGIN)) return metadata(url);
      throw new Error(`unexpected request to ${url}`);
    });
    vi.stubGlobal("fetch", send);
    const inspect = () =>
      inspectModelProfile(configuration(endpoint), {
        catalog: true,
        environment: metadataEnvironment("policy"),
        clock: () => NOW,
      });
    return { send, inspect };
  }

  const inferenceHost = new URL(NVIDIA_INFERENCE_CATALOG_ENDPOINT).hostname;
  const metadataHost = new URL(METADATA_ORIGIN).hostname;

  it("fails the inspection with the refusal, not an unavailable metadata catalog", async () => {
    const { send, inspect } = mixedRoute(inferenceHost, () => {
      throw new Error("the refused metadata host must never be sent a request");
    });
    const error = await inspect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundProxyRefusal);
    expect((error as OutboundProxyRefusal).code).toBe(OUTBOUND_PROXY_INVALID_CODE);
    // The inference catalog was fetched; only the metadata request was refused.
    expect(send.mock.calls.map(([request]) => String(request))).toEqual([
      NVIDIA_INFERENCE_CATALOG_ENDPOINT,
    ]);
  });

  it("positive control: with both hosts bypassed, both catalogs observe", async () => {
    const { inspect } = mixedRoute(`${inferenceHost},${metadataHost}`, (url) =>
      responseAt(url, {
        models: [
          {
            label: "azure/openai/gpt-5.4",
            provider_id: "azure",
            status: "active",
            capabilities: { reasoning: true, chat: true, input_modalities: ["text"] },
            limits: { context_length: 128_000, max_output_tokens: 32_000 },
            pricing: null,
          },
        ],
        next_cursor: null,
      }),
    );
    const report = await inspect();
    expect(report.catalog.sources.map((item) => item.status)).toEqual(["observed", "observed"]);
  });

  it("adjacent: a metadata failure that is not a refusal stays optional", async () => {
    const { inspect } = mixedRoute(`${inferenceHost},${metadataHost}`, () => {
      throw new TypeError("fetch failed");
    });
    const report = await inspect();
    expect(report.catalog.sources).toMatchObject([
      { source: "inference", status: "observed" },
      { source: "metadata", status: "unavailable", code: "request-failed" },
    ]);
  });
});

describe("profile inspection arguments", () => {
  it("accepts each closed flag exactly once", () => {
    expect(parseProfileInspectionArguments(["--catalog", "--judge", "--json"])).toEqual({
      purpose: "judge",
      catalog: true,
      json: true,
      verbose: false,
    });
    expect(parseProfileInspectionArguments(["--catalog", "--verbose"])).toEqual({
      purpose: "policy",
      catalog: true,
      json: false,
      verbose: true,
    });
    expect(() => parseProfileInspectionArguments(["--json", "--verbose"])).toThrow(
      "cannot be combined",
    );
  });

  it.each([
    ["--catalog", "--catalog"],
    ["--judge", "--judge"],
    ["--json", "--json"],
    ["--unknown"],
  ])("rejects duplicate or unknown flags", (...args) => {
    expect(() => parseProfileInspectionArguments(args)).toThrow();
  });

  it("does not echo credential-shaped unknown flags", () => {
    const canary = `--nvapi-${"K".repeat(24)}`;
    for (const parse of [parseProfileInspectionArguments, parseDoctorArguments]) {
      let message = "";
      try {
        parse([canary]);
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toContain(canary);
    }
  });

  it("keeps doctor live and catalog as independent explicit gates", () => {
    expect(parseDoctorArguments(["--use", "local-patch", "--json"])).toMatchObject({
      use: "local-patch",
      json: true,
    });
    expect(() => parseDoctorArguments(["--use", "unknown"])).toThrow(/local-review/u);
    expect(parseDoctorArguments(["--live", "--catalog", "--judge"])).toEqual({
      live: true,
      catalog: true,
      purpose: "judge",
      json: false,
    });
    // `--live` combines with `--json`, alone and with `--catalog`/`--judge`.
    // Exact-shape assertions, so a leaked extra field or a silently dropped flag
    // fails here.
    expect(parseDoctorArguments(["--live", "--json"])).toEqual({
      live: true,
      catalog: false,
      purpose: "policy",
      json: true,
    });
    expect(parseDoctorArguments(["--live", "--catalog", "--json"])).toEqual({
      live: true,
      catalog: true,
      purpose: "policy",
      json: true,
    });
    expect(parseDoctorArguments(["--live", "--catalog", "--judge", "--json"])).toEqual({
      live: true,
      catalog: true,
      purpose: "judge",
      json: true,
    });
    // The other gates still apply.
    expect(() => parseDoctorArguments(["--live", "--json", "--json"])).toThrow("duplicated");
    expect(() => parseDoctorArguments(["--judge"])).toThrow("requires --catalog");
    expect(parseDoctorArguments(["--json"])).toEqual({
      live: false,
      catalog: false,
      purpose: "policy",
      json: true,
    });
    expect(() => parseDoctorArguments(["--live", "--live"])).toThrow("duplicated");
  });
});

function metadataEnvironment(purpose: "policy" | "judge"): NodeJS.ProcessEnv {
  return {
    INFERENCE_HUB_METADATA_ORIGIN: "https://metadata.example.test",
    INFERENCE_HUB_METADATA_PATH: "/v1/catalog/search",
    INFERENCE_HUB_METADATA_MODE: "search",
    INFERENCE_HUB_METADATA_LABEL_PARAMETER: "q",
    INFERENCE_HUB_METADATA_API_KEY: METADATA_KEY,
    [purpose === "judge"
      ? "JUDGE_INFERENCE_HUB_METADATA_LABEL"
      : "MODEL_INFERENCE_HUB_METADATA_LABEL"]: "azure/openai/gpt-5.4",
  };
}

function snapshotSummary(report: ModelProfileInspectionV1): unknown {
  return {
    purpose: report.purpose,
    runtime: report.runtime,
    sources: report.catalog.sources.map((item) => ({
      source: item.source,
      status: item.status,
      code: item.code,
    })),
    disposition: report.catalog.reconciliation?.decision.disposition ?? null,
    context: report.fields.find((item) => item.field === "contextWindow")?.effective,
    input: report.fields.find((item) => item.field === "maxInputTokens")?.proposed,
    reasons: report.reasons,
    remediation: report.remediation,
  };
}

function responseAt(url: string, value: unknown): Response {
  const response = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function reportDigest(report: ModelProfileInspectionV1): string {
  const { sha256: _sha256, ...withoutDigest } = report;
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(withoutDigest as unknown as JsonEvidenceValue))
    .digest("hex");
}
