// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { sha256 } from "../src/content-ir/canonical.js";
import {
  decodeLiveAgentTaskRequestV1,
  LIVE_AGENT_TASK_REQUEST_KIND,
  LiveAgentTaskContractError,
  type LiveAgentTaskRequestV1,
} from "../src/live-agent/task-contract.js";

function request(overrides: Partial<LiveAgentTaskRequestV1> = {}): LiveAgentTaskRequestV1 {
  const promptText = "Write the cafés page. e\u0301 stays byte-exact.";
  return {
    schemaVersion: 1,
    kind: LIVE_AGENT_TASK_REQUEST_KIND,
    taskId: "task-contract-1",
    sessionId: "session-contract-1",
    prompt: {
      encoding: "utf-8",
      text: promptText,
      sha256: sha256(Buffer.from(promptText, "utf8")),
    },
    baseline: {
      repositoryRevision: "a".repeat(40),
      contentSha256: "b".repeat(64),
    },
    sources: [
      {
        schemaVersion: 1,
        kind: "docsfab-prepared-local-source",
        sourceId: "docs-source",
        repositoryRevision: "c".repeat(40),
        contentSha256: "d".repeat(64),
        paths: ["docs"],
      },
    ],
    scope: {
      documentationRoots: ["docs"],
      requestedPaths: ["docs/guide.md"],
      writeClass: "documentation",
    },
    requiredEvidence: ["empty-diff"],
    effectiveConfig: {
      profileId: "profile-default",
      modelId: "model-default",
      configurationSha256: "e".repeat(64),
      values: {},
    },
    ...overrides,
  };
}

describe("live-agent task request contract", () => {
  it("preserves the exact prompt text and admits a digest-bound, narrowed v1 request", () => {
    const value = request();
    const decoded = decodeLiveAgentTaskRequestV1(value);
    expect(decoded.prompt.text).toBe(value.prompt.text);
    expect(decoded.prompt.sha256).toBe(sha256(Buffer.from(value.prompt.text, "utf8")));
    expect(decoded.scope).toEqual({
      documentationRoots: ["docs"],
      requestedPaths: ["docs/guide.md"],
      writeClass: "documentation",
    });
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.sources[0])).toBe(true);
  });

  it("rejects unsupported versions, prompt digest changes, and paths outside the declared roots", () => {
    expect(() => decodeLiveAgentTaskRequestV1({ ...request(), schemaVersion: 2 })).toThrow(
      expect.objectContaining({ code: "unsupported-version" }),
    );
    const changedPrompt = request({
      prompt: { ...request().prompt, text: "changed prompt" },
    });
    expect(() => decodeLiveAgentTaskRequestV1(changedPrompt)).toThrow(
      expect.objectContaining({ code: "digest-mismatch" }),
    );
    expect(() =>
      decodeLiveAgentTaskRequestV1(
        request({ scope: { ...request().scope, requestedPaths: ["src/index.ts"] } }),
      ),
    ).toThrow(expect.objectContaining({ code: "scope-not-narrow" }));
  });

  it("rejects a malformed prepared source reference before host binding", () => {
    const malformed: unknown = {
      ...request(),
      sources: [{ ...request().sources[0], sourceId: "../outside" }],
    };
    try {
      decodeLiveAgentTaskRequestV1(malformed);
      throw new Error("expected task request rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveAgentTaskContractError);
      expect((error as LiveAgentTaskContractError).code).toBe("invalid-value");
    }
  });
});
