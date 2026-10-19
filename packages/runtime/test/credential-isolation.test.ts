// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertConfinedToolResultCredentialFree,
  assertModelRequestCredentialFree,
  assertModelResponseCredentialFree,
  CredentialBoundaryError,
} from "../src/security/credential-isolation.js";
import { createModelConnection } from "../src/model/provider.js";
import { validModelConfig } from "./helpers.js";
import { configureCredential } from "./helpers/configured-credential.js";

// Synthetic, never-real token shapes. Under the owner decision on #1807 a
// shape alone never crosses a boundary refusal; only a configured credential
// does.
const GITLAB_TOKEN = `glpat-${"a".repeat(24)}`;
const NVIDIA_TOKEN = `nvapi-${"b".repeat(24)}`;
// A configured credential, deliberately not shaped like one, so only an exact
// match against the configured value can find it.
const CONFIGURED = ["fixture", "orchard", "lamp", "quietly", "hums"].join("-");
const CONFIGURED_SOURCE = "environment variable DOCSFAB_FIXTURE_ISOLATION_TOKEN";

function configure(): void {
  configureCredential(CONFIGURED, "DOCSFAB_FIXTURE_ISOLATION_TOKEN");
}

function caught(run: () => void): CredentialBoundaryError {
  let error: unknown;
  try {
    run();
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(CredentialBoundaryError);
  return error as CredentialBoundaryError;
}

describe("C-04 exact outbound model-request credential guard", () => {
  it("rejects a credential embedded in an exact prompt message before transmission", () => {
    configure();
    const context = {
      systemPrompt: "Improve the documentation.",
      messages: [{ role: "user", content: `here is my token ${CONFIGURED}` }],
    };
    const boundaryError = caught(() => assertModelRequestCredentialFree(context));
    expect(boundaryError.code).toBe("credential-isolation-boundary");
    expect(boundaryError.boundary).toBe("model-request");
    expect(boundaryError.name).toBe("CredentialBoundaryError");
    expect(boundaryError.credentialSource).toBe(CONFIGURED_SOURCE);
    // The message reaches the model through confined tools, so it never names
    // the configuration; the operator's next action does.
    expect(boundaryError.message).toBe(
      "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.",
    );
    expect(boundaryError.nextAction).toContain("transport authentication");
    expect(boundaryError.nextAction).toContain(
      `It matched the configured credential from ${CONFIGURED_SOURCE}.`,
    );
    expect(boundaryError.nextAction).not.toContain(CONFIGURED);
  });

  it("rejects a configured credential echoed back by a tool result, even as a piece", () => {
    configure();
    const piece = CONFIGURED.slice(3, 3 + 16);
    for (const text of [`NVIDIA_API_KEY=${CONFIGURED}`, `key ${piece}... was refused`]) {
      const context = {
        systemPrompt: "Improve the documentation.",
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text }],
          },
        ],
      };
      expect(() => assertModelRequestCredentialFree(context), text).toThrow(
        CredentialBoundaryError,
      );
    }
  });

  it("sends repository content that only looks like a credential (#1807)", () => {
    configure();
    const context = {
      systemPrompt: "Improve the documentation.",
      messages: [
        { role: "user", content: `Document the sample token ${GITLAB_TOKEN}.` },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: `NVIDIA_API_KEY=${NVIDIA_TOKEN}` }],
        },
      ],
    };
    expect(() => assertModelRequestCredentialFree(context)).not.toThrow();
  });

  it("permits a benign request even when a configured credential exists elsewhere", () => {
    configure();
    const context = {
      systemPrompt: "Improve the documentation.",
      messages: [{ role: "user", content: "Fix the heading and add a runnable example." }],
    };
    expect(() => assertModelRequestCredentialFree(context)).not.toThrow();
  });

  it("fails closed when the exact request cannot be serialized for inspection", () => {
    const context = { systemPrompt: "x", extra: BigInt(7) } as unknown;
    expect(caught(() => assertModelRequestCredentialFree(context)).boundary).toBe("model-request");
  });

  it("blocks a configured-credential request before any provider transport occurs", async () => {
    configure();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("provider transport must not be invoked for a blocked request.");
    }) as typeof fetch;
    try {
      const connection = await createModelConnection(validModelConfig);
      expect(() =>
        connection.runtime.streamSimple(connection.model, {
          systemPrompt: "Improve the documentation.",
          messages: [{ role: "user", content: `credential ${CONFIGURED}`, timestamp: 1 }],
        }),
      ).toThrow(CredentialBoundaryError);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("C-15 inbound model-response credential guard", () => {
  it("rejects a configured credential in provider output without echoing it", () => {
    configure();
    const boundaryError = caught(() => assertModelResponseCredentialFree({ text: CONFIGURED }));
    expect(boundaryError.boundary).toBe("model-response");
    expect(String(boundaryError)).not.toContain(CONFIGURED);
  });

  it("accepts provider output that only looks like a credential", () => {
    configure();
    expect(() => assertModelResponseCredentialFree({ text: GITLAB_TOKEN })).not.toThrow();
  });
});

describe("C-04 confined-tool-result credential intercept", () => {
  it("rejects a configured credential in a Pi tool result with the confined-tool-result boundary", () => {
    configure();
    const result = {
      content: [{ type: "text", text: `NVIDIA_API_KEY=${CONFIGURED}` }],
    };
    const boundaryError = caught(() => assertConfinedToolResultCredentialFree(result));
    expect(boundaryError.code).toBe("credential-isolation-boundary");
    expect(boundaryError.boundary).toBe("confined-tool-result");
    expect(boundaryError.message).not.toContain(CONFIGURED);
    expect(boundaryError.nextAction).toContain("inference step may continue");
    expect(boundaryError.nextAction).not.toContain(CONFIGURED);
  });

  it("returns a tool result that only looks like a credential", () => {
    configure();
    const result = {
      content: [{ type: "text", text: `NVIDIA_API_KEY=${NVIDIA_TOKEN}` }],
    };
    expect(() => assertConfinedToolResultCredentialFree(result)).not.toThrow();
  });

  it("fails closed when the exact tool result cannot be serialized for inspection", () => {
    const result = { content: [{ type: "text", text: "ok" }], extra: BigInt(7) } as unknown;
    expect(caught(() => assertConfinedToolResultCredentialFree(result)).boundary).toBe(
      "confined-tool-result",
    );
  });
});
