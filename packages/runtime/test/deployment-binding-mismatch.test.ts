// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertInstalledDeploymentBaseUrl,
  loadInstalledModelCompositionAuthority,
  ModelCompositionError,
  type InstalledModelCompositionAuthority,
} from "../src/model-composition/index.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";

/**
 * `assertInstalledDeploymentBaseUrl` throws `deployment-binding-mismatch` for an
 * unparseable base URL, a disallowed URL shape (credentials, query, or
 * fragment), and a deployment identity digest mismatch. Each cause carries its
 * own operator-facing explanation and next action.
 */
describe("deployment-binding-mismatch: explanation and next action per cause", () => {
  const COMPOSITION_ID = "openai-gpt-5.6-sol-pi";

  async function authority(): Promise<InstalledModelCompositionAuthority> {
    return (await loadInstalledModelCompositionAuthority()).authority;
  }

  function assertMismatch(auth: InstalledModelCompositionAuthority, baseUrl: string) {
    expect(() =>
      assertInstalledDeploymentBaseUrl({
        authority: auth,
        compositionId: COMPOSITION_ID,
        baseUrl,
      }),
    ).toThrow(ModelCompositionError);
    try {
      assertInstalledDeploymentBaseUrl({ authority: auth, compositionId: COMPOSITION_ID, baseUrl });
      throw new Error("expected ModelCompositionError");
    } catch (error) {
      if (!(error instanceof ModelCompositionError)) throw error;
      return error;
    }
  }

  it("cause 1: an unparseable base URL gets its own explanation and next action", async () => {
    const error = assertMismatch(await authority(), "not a url at all");

    expect(error.code).toBe("deployment-binding-mismatch");
    expect(error.message).not.toBe("deployment-binding-mismatch");
    expect(error.message).toMatch(/could not be parsed as a URL/u);
    expect(error.nextAction).toBeDefined();
    expect(error.nextAction).toMatch(/MODEL_BASE_URL/u);

    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("deployment-binding-mismatch");
    expect(envelope.message).not.toBe("deployment-binding-mismatch");
    expect(envelope.message).toBe(error.message);
    expect(envelope.nextAction).toBe(error.nextAction);
    expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
  });

  it("cause 2: a disallowed URL shape (credentials in the URL) gets its own explanation and next action", async () => {
    const error = assertMismatch(await authority(), "https://user:password@api.openai.com/v1");

    expect(error.code).toBe("deployment-binding-mismatch");
    expect(error.message).toMatch(/not an allowed deployment shape/u);
    expect(error.message).toMatch(/username|password/u);
    expect(error.nextAction).toBeDefined();
    expect(error.nextAction).toMatch(/credentials/u);

    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.message).toBe(error.message);
    expect(envelope.nextAction).toBe(error.nextAction);
    expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
  });

  it("cause 2b: a disallowed URL shape (query string) is also distinguished, not folded into shape-1", async () => {
    const error = assertMismatch(await authority(), "https://api.openai.com/v1?foo=bar");
    expect(error.code).toBe("deployment-binding-mismatch");
    expect(error.message).toMatch(/not an allowed deployment shape/u);
  });

  it("cause 3: a well-formed URL whose deployment identity does not match gets its own explanation and next action", async () => {
    const error = assertMismatch(await authority(), "https://api.openai.com/v2");

    expect(error.code).toBe("deployment-binding-mismatch");
    expect(error.message).toMatch(/does not match the deployment identity/u);
    expect(error.message).toContain(COMPOSITION_ID);
    // The sealed identity provably recomputes to api.openai.com for the
    // "openai-api" route, so the refusal may name it; naming an unproven origin
    // is the defect to guard against.
    expect(error.message).toContain("https://api.openai.com");
    expect(error.nextAction).toBeDefined();
    expect(error.nextAction).toMatch(/docsfab composition list/u);

    const envelope = toOperatorErrorEnvelope(error);
    // The recorded origin is operator-facing configuration, not a secret.
    // Keep it in both the thrown message and the envelope so JSON/human
    // output still names what MODEL_BASE_URL must match.
    expect(envelope.message).toBe(error.message);
    expect(envelope.message).toContain("https://api.openai.com");
    expect(envelope.message).not.toContain("[REDACTED]");
    expect(envelope.nextAction).toBe(error.nextAction);
    expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
  });

  it("all three causes share the machine code but never share the same explanation", async () => {
    const auth = await authority();
    const unparseable = assertMismatch(auth, "not a url at all");
    const disallowedShape = assertMismatch(auth, "https://user:password@api.openai.com/v1");
    const identityMismatch = assertMismatch(auth, "https://api.openai.com/v2");

    for (const error of [unparseable, disallowedShape, identityMismatch]) {
      expect(error.code).toBe("deployment-binding-mismatch");
    }

    const messages = [unparseable.message, disallowedShape.message, identityMismatch.message];
    expect(new Set(messages).size).toBe(3);

    const nextActions = [
      unparseable.nextAction,
      disallowedShape.nextAction,
      identityMismatch.nextAction,
    ];
    for (const nextAction of nextActions) {
      expect(typeof nextAction).toBe("string");
      expect(nextAction!.length).toBeGreaterThan(0);
    }
    expect(new Set(nextActions).size).toBe(3);
  });

  it("`--json` no longer repeats the code as the message for any cause", async () => {
    const auth = await authority();
    for (const baseUrl of [
      "not a url at all",
      "https://user:password@api.openai.com/v1",
      "https://api.openai.com/v2",
    ]) {
      const error = assertMismatch(auth, baseUrl);
      const envelope = toOperatorErrorEnvelope(error);
      const serialized = JSON.stringify(envelope);
      const parsed = JSON.parse(serialized) as {
        code: string;
        message: string;
        nextAction?: string;
      };
      expect(parsed.code).toBe("deployment-binding-mismatch");
      expect(parsed.message).not.toBe(parsed.code);
      expect(parsed.nextAction).toBeDefined();
    }
  });
});
