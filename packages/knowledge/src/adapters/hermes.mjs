// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  RUNTIME_ADAPTER_VERSION,
  renderWorkPacketPrompt,
} from "../runtime-adapter.mjs";

function requireRunId(runId) {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("Hermes run id is required");
  }
  return encodeURIComponent(runId);
}

export class HermesRuntimeAdapter {
  #apiKey;
  #capabilities = null;
  #fetch;
  #initialized = false;

  constructor({ baseUrl = "http://127.0.0.1:8642", apiKey, fetchImplementation = fetch }) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
      throw new Error("Hermes adapter requires a loopback HTTP endpoint");
    }
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new Error("Hermes API key is required");
    }
    if (typeof fetchImplementation !== "function") {
      throw new Error("Hermes adapter requires a fetch implementation");
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.contractVersion = RUNTIME_ADAPTER_VERSION;
    this.name = "hermes";
    this.#apiKey = apiKey;
    this.#fetch = fetchImplementation;
  }

  async initialize({ timeoutMs = 5000 } = {}) {
    const health = await this.#request("/health", { timeoutMs, authenticated: false });
    if (health.status !== "ok") {
      throw new Error(`Hermes liveness check returned ${String(health.status)}`);
    }
    const capabilities = await this.#request("/v1/capabilities", { timeoutMs });
    const requiredFeatures = ["run_submission", "run_status", "run_stop"];
    const missing = requiredFeatures.filter(
      (feature) => capabilities.features?.[feature] !== true,
    );
    if (missing.length > 0) {
      throw new Error(`Hermes is missing required capabilities: ${missing.join(", ")}`);
    }
    this.#capabilities = structuredClone(capabilities);
    this.#initialized = true;
    return { health, capabilities: structuredClone(capabilities) };
  }

  async startRun({ task, canonicalContext, instructions, timeoutMs = 10000 }) {
    this.#assertInitialized();
    const input = renderWorkPacketPrompt(task, canonicalContext);
    return this.#request("/v1/runs", {
      method: "POST",
      timeoutMs,
      body: {
        input,
        session_id: `docsfab-knowledge-${task.id}`,
        instructions:
          instructions ??
          "Execute only the bounded DocsFab knowledge-gathering work packet. Preserve provenance and surface uncertainty.",
      },
    });
  }

  async getRun(runId, { timeoutMs = 5000 } = {}) {
    this.#assertInitialized();
    return this.#request(`/v1/runs/${requireRunId(runId)}`, { timeoutMs });
  }

  async stopRun(runId, { timeoutMs = 5000 } = {}) {
    this.#assertInitialized();
    return this.#request(`/v1/runs/${requireRunId(runId)}/stop`, {
      method: "POST",
      timeoutMs,
      body: {},
    });
  }

  capabilities() {
    this.#assertInitialized();
    return structuredClone(this.#capabilities);
  }

  #assertInitialized() {
    if (!this.#initialized) {
      throw new Error("Hermes adapter is not initialized");
    }
  }

  async #request(path, options = {}) {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Hermes request timeout must be a positive integer");
    }
    const headers = { accept: "application/json" };
    if (options.authenticated !== false) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }
    let body;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await this.#fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = {};
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`Hermes returned invalid JSON for ${path}`, { cause: error });
      }
    }
    if (!response.ok) {
      throw new Error(
        `Hermes ${path} failed with HTTP ${response.status}: ${payload.error ?? payload.detail ?? "no error detail"}`,
      );
    }
    return payload;
  }
}
