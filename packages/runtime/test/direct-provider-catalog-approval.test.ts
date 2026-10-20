// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import {
  ANTHROPIC_API_ORIGIN,
  OPENAI_API_ORIGIN,
  resolveModelCatalogAdapterSet,
} from "../src/model/catalog-serving-route.js";
import { MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER } from "../src/model/catalog-provenance.js";
import { approveModelProfile } from "../src/model/profile-approval.js";
import {
  applyProfileConfiguration,
  applyProfileRollback,
  prepareProfileApply,
  prepareProfileRollback,
} from "../src/model/profile-apply.js";
import {
  inspectModelEndpointProfile,
  inspectModelProfile,
} from "../src/model/profile-inspection.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const execFile = promisify(execFileCallback);
const NOW = new Date("2026-08-04T12:34:56.789Z");
const OPENAI_MODEL = "gpt-5.6-sol";
const ANTHROPIC_MODEL = "claude-opus-4-7";
const OPENAI_KEY = `sk-${"A".repeat(24)}`;
const ANTHROPIC_KEY = `sk-ant-${"A".repeat(24)}`;
const HUB_KEY = `ihub_api_${"Z".repeat(24)}`;
const OPENAI_URL = `${OPENAI_API_ORIGIN}/v1/models/${OPENAI_MODEL}`;
const ANTHROPIC_URL = `${ANTHROPIC_API_ORIGIN}/v1/models/${ANTHROPIC_MODEL}`;

let previousHubKey: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHubKey === undefined) delete process.env.INFERENCE_HUB_METADATA_API_KEY;
  else process.env.INFERENCE_HUB_METADATA_API_KEY = previousHubKey;
  previousHubKey = undefined;
});

describe("direct-provider catalog-approval adapters", () => {
  it("selects OpenAI, Anthropic, NVIDIA, and unimplemented serving routes", () => {
    expect(resolveModelCatalogAdapterSet(openaiEndpoint())).toBe("openai-api");
    expect(resolveModelCatalogAdapterSet(anthropicEndpoint())).toBe("anthropic-api");
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "nvidia",
        baseUrl: HUB_BASE_URL,
      }),
    ).toBe("nvidia-inference-api");
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      }),
    ).toBe("unimplemented");
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1/embeddings",
      }),
    ).toBe("unimplemented");
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "nim",
        baseUrl: "https://nim.internal.test/v1",
      }),
    ).toBe("unimplemented");
  });

  it("inspects OpenAI without reading Hub Metadata, including the CLI default env", async () => {
    previousHubKey = process.env.INFERENCE_HUB_METADATA_API_KEY;
    process.env.INFERENCE_HUB_METADATA_API_KEY = HUB_KEY;
    const fetch = vi.fn(async (request: RequestInfo | URL) =>
      catalogResponse(String(request), openaiBody()),
    );
    const report = await inspectModelEndpointProfile(openaiEndpoint(), "policy", {
      catalog: true,
      fetch: fetch as typeof globalThis.fetch,
      clock: () => NOW,
    });
    expect(fetch.mock.calls.map(([request]) => String(request))).toEqual([OPENAI_URL]);
    expect(report.catalog.sources).toMatchObject([
      { source: "inference", status: "observed", code: null },
      { source: "metadata", status: "unavailable", code: "hub-metadata-not-applicable" },
    ]);
    expect(report.catalog.reconciliation?.decision.reconciliationPolicy).toEqual(
      MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER,
    );
    expect(
      report.catalog.reconciliation?.proposal?.fields.some(
        (field) =>
          field.derivation.kind === "rule" &&
          field.derivation.rule === "combined-context-input-clamp@1",
      ),
    ).toBe(false);
    expect(report.catalog.reconciliation?.decision.disposition).toBe("review-required");
    expect(JSON.stringify(report)).not.toContain(HUB_KEY);
    expect(JSON.stringify(report)).not.toContain(OPENAI_KEY);
  });

  it("inspects Anthropic without Hub Metadata and stamps the direct-provider policy", async () => {
    const fetch = vi.fn(async (request: RequestInfo | URL) =>
      catalogResponse(String(request), anthropicBody()),
    );
    const report = await inspectModelProfile(configuration(anthropicEndpoint()), {
      catalog: true,
      environment: hubTrap({ INFERENCE_HUB_METADATA_API_KEY: HUB_KEY }),
      fetch: fetch as typeof globalThis.fetch,
      clock: () => NOW,
    });
    expect(fetch.mock.calls.map(([request]) => String(request))).toEqual([ANTHROPIC_URL]);
    expect(report.catalog.sources[1]).toMatchObject({
      source: "metadata",
      status: "unavailable",
      code: "hub-metadata-not-applicable",
    });
    expect(report.catalog.reconciliation?.decision.reconciliationPolicy.id).toBe(
      "docsfab-direct-provider-catalog-reconciliation",
    );
    expect(report.catalog.reconciliation?.decision.disposition).toBe("ready");
    expect(report.subject.apiFormat).toBe("messages");
  });

  it("does not request Hub credentials for unimplemented NIM, API Catalog, or embeddings routes", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("unimplemented routes must not fetch");
    });
    for (const endpoint of [
      openaiEndpoint({
        providerId: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: `nvapi-${"E".repeat(24)}`,
      }),
      openaiEndpoint({
        providerId: "nim",
        baseUrl: "https://nim.internal.test/v1",
        apiKey: `nvapi-${"F".repeat(24)}`,
      }),
      openaiEndpoint({ baseUrl: "https://api.openai.com/v1/embeddings" }),
    ]) {
      const report = await inspectModelEndpointProfile(endpoint, "policy", {
        catalog: true,
        environment: hubTrap({ INFERENCE_HUB_METADATA_API_KEY: HUB_KEY }),
        fetch: fetch as typeof globalThis.fetch,
        clock: () => NOW,
      });
      expect(report.catalog.sources).toMatchObject([
        { source: "inference", status: "unavailable", code: "adapter-not-implemented" },
        { source: "metadata", status: "unavailable", code: "adapter-not-implemented" },
      ]);
      expect(report.catalog.reconciliation).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses OpenAI catalog approval when Models retrieve omits token limits", async () => {
    const fetch = vi.fn(async (request: RequestInfo | URL) =>
      catalogResponse(String(request), openaiBody()),
    );
    const report = await inspectModelEndpointProfile(openaiEndpoint(), "policy", {
      catalog: true,
      environment: hubTrap(),
      fetch: fetch as typeof globalThis.fetch,
      clock: () => NOW,
    });
    const proposal = report.catalog.reconciliation?.proposal;
    if (!proposal) throw new Error("direct-provider inspection did not propose");
    expect(report.catalog.reconciliation?.decision.disposition).toBe("review-required");
    const keys = generateKeyPairSync("ed25519");
    expect(() =>
      approveModelProfile({
        inspection: report,
        purpose: "policy",
        proposalSha256: proposal.sha256,
        effectiveDate: NOW.toISOString().slice(0, 10),
        reviewAfter: new Date(NOW.valueOf() + 28 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
        conflictFields: [],
        authority: {
          id: "operator:catalog-review",
          publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
        privateKey: keys.privateKey,
        endpoint: openaiEndpoint(),
        now: NOW,
      }),
    ).toThrow();
  });

  it("signs, applies, and rolls back an Anthropic catalog approval without Hub Metadata", async () => {
    await runApplyRollback(anthropicEndpoint(), anthropicBody(), {
      MODEL_API_FORMAT: "messages",
      MODEL_COMPATIBLE_API_FORMATS: "messages",
    });
  }, 30_000);
});

async function runApplyRollback(
  endpoint: ModelEndpointConfig,
  body: Record<string, unknown>,
  formatEnv: { MODEL_API_FORMAT: string; MODEL_COMPATIBLE_API_FORMATS: string },
): Promise<void> {
  const fetch = vi.fn(async (request: RequestInfo | URL) => catalogResponse(String(request), body));
  const report = await inspectModelEndpointProfile(endpoint, "policy", {
    catalog: true,
    environment: hubTrap(),
    fetch: fetch as typeof globalThis.fetch,
    clock: () => NOW,
  });
  const proposal = report.catalog.reconciliation?.proposal;
  if (!proposal) throw new Error("direct-provider inspection did not propose");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const bundle = approveModelProfile({
    inspection: report,
    purpose: "policy",
    proposalSha256: proposal.sha256,
    effectiveDate: NOW.toISOString().slice(0, 10),
    reviewAfter: new Date(NOW.valueOf() + 28 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
    conflictFields: [],
    authority: { id: "operator:catalog-review", publicKey },
    privateKey: keys.privateKey,
    endpoint,
    now: NOW,
  });
  expect(bundle.modelEvidence.profile?.schemaVersion).toBe(2);
  expect(JSON.stringify(bundle)).not.toContain(endpoint.apiKey);
  expect(JSON.stringify(bundle)).not.toContain("ihub_api_");
  expect(JSON.stringify(bundle)).not.toContain("INFERENCE_HUB_METADATA_API_KEY");

  const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-direct-provider-apply-")));
  try {
    await git(root, "init", "--quiet");
    await writeFile(
      resolve(root, ".gitignore"),
      ".env\n.env.docsfab-new-*\n.env.docsfab-rollback-*\n.env.docsfab-apply.lock\n.env.docsfab-transaction.json\n.env.docsfab-recovery.claim\n",
    );
    const envPath = resolve(root, ".env");
    const original = [
      "# owner configuration",
      ...Object.entries({
        ...validModelEnvironment,
        MODEL_PROVIDER: endpoint.providerId,
        MODEL_BASE_URL: endpoint.baseUrl,
        MODEL_ID: endpoint.modelId,
        MODEL_API_KEY: endpoint.apiKey,
        MODEL_CONTEXT_WINDOW: "8192",
        MODEL_MAX_OUTPUT_TOKENS: "4096",
        MODEL_PROFILE_APPROVED_SOURCE: "unknown",
        MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
        MODEL_PROFILE_REVIEW_AFTER: "unknown",
        ...formatEnv,
      }).map(([key, value]) => `${key}=${value}`),
      "UNRELATED=preserved",
      "",
    ].join("\n");
    await writeFile(envPath, original, { mode: 0o600 });
    const prepared = await prepareProfileApply({
      projectRoot: root,
      purpose: "policy",
      inspection: report,
      approvalBundle: bundle,
      authority: { id: "operator:catalog-review", publicKey },
      ambientEnvironment: {},
      now: NOW,
    });
    const applyReceipt = await applyProfileConfiguration({
      prepared,
      confirmPatchSha256: prepared.preview.patch.sha256,
      inspection: report,
      approvalBundle: bundle,
      authority: { id: "operator:catalog-review", publicKey },
      ambientEnvironment: {},
      now: NOW,
      receiptPath: resolve(root, "apply-receipt.json"),
    });
    expect(applyReceipt.applied).toBe(true);
    const after = await readFile(envPath, "utf8");
    expect(after).toContain(`MODEL_API_KEY=${endpoint.apiKey}`);
    expect(after).toContain("UNRELATED=preserved");
    expect(after.includes("INFERENCE_HUB_METADATA_API_KEY")).toBe(false);
    expect(Number((await lstat(envPath)).mode & 0o777)).toBe(0o600);

    const rollback = await prepareProfileRollback({ projectRoot: root, receipt: applyReceipt });
    const rollbackReceipt = await applyProfileRollback({
      prepared: rollback,
      receipt: applyReceipt,
      confirmRollbackSha256: rollback.preview.sha256,
      receiptPath: resolve(root, "rollback-receipt.json"),
      now: NOW,
    });
    expect(rollbackReceipt.toSha256).toBe(applyReceipt.beforeSha256);
    expect(await readFile(envPath, "utf8")).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function openaiEndpoint(overrides: Partial<ModelEndpointConfig> = {}): ModelEndpointConfig {
  const base = structuredClone(validModelConfig);
  return {
    ...base,
    providerId: "openai",
    baseUrl: `${OPENAI_API_ORIGIN}/v1`,
    modelId: OPENAI_MODEL,
    apiKey: OPENAI_KEY,
    apiFormat: "chat_completions",
    profile: {
      ...base.profile,
      input: ["text"],
      compatibility: { ...base.profile.compatibility, apiFormats: ["chat_completions"] },
    },
    ...overrides,
  };
}

function anthropicEndpoint(): ModelEndpointConfig {
  const base = structuredClone(validModelConfig);
  return {
    ...base,
    providerId: "anthropic",
    baseUrl: `${ANTHROPIC_API_ORIGIN}/v1`,
    modelId: ANTHROPIC_MODEL,
    apiKey: ANTHROPIC_KEY,
    apiFormat: "messages",
    profile: {
      ...base.profile,
      input: ["text"],
      compatibility: { ...base.profile.compatibility, apiFormats: ["messages"] },
    },
  };
}

function configuration(model: ModelEndpointConfig): DocsFabConfig {
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

function openaiBody(): Record<string, unknown> {
  return {
    id: OPENAI_MODEL,
    object: "model",
    created: 1_704_067_200,
    owned_by: "openai",
  };
}

function anthropicBody(): Record<string, unknown> {
  return {
    id: ANTHROPIC_MODEL,
    type: "model",
    created_at: "2026-01-15T00:00:00.000Z",
    max_input_tokens: 200_000,
    max_tokens: 8_192,
  };
}

function catalogResponse(url: string, body: unknown): Response {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function hubTrap(base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "INFERENCE_HUB_METADATA_API_KEY") {
        throw new Error("must not read INFERENCE_HUB_METADATA_API_KEY");
      }
      return Reflect.get(target, prop, receiver);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "INFERENCE_HUB_METADATA_API_KEY") {
        throw new Error("must not inspect INFERENCE_HUB_METADATA_API_KEY");
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
    },
  });
}
