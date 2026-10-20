// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A configured credential in the model request context (#1807): the backstop
 * screen of the message graph refuses it before any request is sent. The step
 * ends with that refusal, coded, as a refusal of the request payload or of
 * the provider's response does, not as an unclassified provider failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import { CredentialBoundaryError } from "../src/security/credential-isolation.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import {
  captureInferenceFailure,
  createAuditHarness,
  createRepository,
  createReviewHarness,
  resetSharedTestState,
  stepInput,
} from "./support/pi-harness-session-fixtures.js";

const SESSION = 60_000;

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetSharedTestState();
});

describe("a configured credential in the model request context (#1807)", () => {
  it.each([
    ["without a composition policy", false],
    ["with a composition policy", true],
  ] as const)(
    "ends the step with a coded credential-isolation stop, %s, and sends nothing",
    async (_label, withComposition) => {
      const repositoryPath = await createRepository();
      // A configured value that does not look like a credential, so only the
      // exact match finds it.
      const credential = configureCredential(
        ["harbor", plantedCredentialValue(withComposition ? 1302 : 1301, 24)].join("-"),
      );
      const requests: unknown[] = [];
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        requests.push(init?.body);
        throw new Error("Unexpected provider request.");
      });
      const harness = withComposition
        ? await createReviewHarness(true)
        : await createAuditHarness();

      const error = await captureInferenceFailure(harness, {
        ...stepInput(repositoryPath),
        instruction: `Review the setup page. ${credential}`,
      });

      const refusal = new CredentialBoundaryError("model-request");
      expect(error.message).toBe(
        `Model request failed [provider-terminal; retryable=false]: ${refusal.message}`,
      );
      expect(error.retryable).toBe(false);
      expect(error.cause).toBeInstanceOf(CredentialBoundaryError);
      expect((error.cause as CredentialBoundaryError).boundary).toBe("model-request");
      expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
      expect(classifyThrownFailure(error, "workflow")).toEqual({
        class: "operator-input",
        layer: "workflow",
        code: "credential-isolation-boundary",
      });
      // Refused before the transport: no request left, and none was replayed.
      expect(requests).toEqual([]);
      expect(JSON.stringify({ error, evidence: error.evidence })).not.toContain(credential);
    },
    SESSION,
  );

  it(
    "sends the same request when the context holds no configured credential",
    async () => {
      const repositoryPath = await createRepository();
      // Planted but never configured: the same text is not DocsFab's own.
      const value = ["harbor", plantedCredentialValue(1303, 24)].join("-");
      const requests: unknown[] = [];
      // A terminal provider answer, so the step ends after the one request.
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        requests.push(init?.body);
        return new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      });

      const error = await captureInferenceFailure(await createAuditHarness(), {
        ...stepInput(repositoryPath),
        instruction: `Review the setup page. ${value}`,
      });

      expect(requests).toHaveLength(1);
      expect(error.cause).not.toBeInstanceOf(CredentialBoundaryError);
      expect(classifyThrownFailure(error, "workflow").code).not.toBe(
        "credential-isolation-boundary",
      );
    },
    SESSION,
  );
});
