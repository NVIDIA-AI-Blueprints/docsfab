// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { JsonEvidenceError } from "../src/json-evidence.js";
import type { ModelProfile } from "../src/model/configuration.js";
import {
  createProfileEnvironmentPatch,
  createProfileEnvironmentRollback,
  decodeProfileEnvironmentPatch,
  profileEnvironmentKeys,
  ProfileEnvironmentError,
  projectProfileEnvironment,
} from "../src/model/profile-environment.js";

const profile: ModelProfile = {
  configuredLimits: {
    contextWindow: 128_000,
    maxInputTokens: 111_616,
    maxOutputTokens: 16_384,
  },
  contextWindow: 128_000,
  maxInputTokens: 111_616,
  maxOutputTokens: 16_384,
  effectiveLimitReason: "none",
  reasoning: true,
  input: ["text", "image"],
  compatibility: {
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    apiFormats: ["chat_completions", "messages"],
  },
  costPerMillionTokens: {
    input: null,
    output: 0,
    cacheRead: 0.125,
    cacheWrite: null,
  },
  metadata: {
    approvedSource: "https://catalog.example.test/models/example",
    effectiveDate: "2026-08-04",
    reviewAfter: "2026-09-04",
    status: "current",
  },
};

describe("profile environment projection", () => {
  it("projects only the policy allowlist and preserves unknown prices", () => {
    const values = projectProfileEnvironment("policy", profile);

    expect(Object.keys(values)).toEqual(profileEnvironmentKeys("policy"));
    expect(values.MODEL_INPUT_COST_PER_MILLION).toBe("unknown");
    expect(values.MODEL_CACHE_WRITE_COST_PER_MILLION).toBe("unknown");
    expect(values.MODEL_OUTPUT_COST_PER_MILLION).toBe("0");
    expect(values).not.toHaveProperty("MODEL_PROVIDER");
    expect(values).not.toHaveProperty("MODEL_API_KEY");
  });

  it("keeps policy and judge namespaces independent", () => {
    expect(profileEnvironmentKeys("policy").every((key) => key.startsWith("MODEL_"))).toBe(true);
    expect(profileEnvironmentKeys("judge").every((key) => key.startsWith("JUDGE_"))).toBe(true);
  });

  it("rejects a malformed runtime purpose instead of falling through to judge", () => {
    expect(() => profileEnvironmentKeys("other" as "policy")).toThrow(ProfileEnvironmentError);
  });
});

describe("profile environment patch", () => {
  it("preserves comments, ordering, unrelated values, credentials, CRLF, and final newline", () => {
    const before = [
      "# owner settings",
      "MODEL_PROVIDER=do-not-change",
      "MODEL_API_KEY=nvapi-SUPER-SECRET",
      "MODEL_CONTEXT_WINDOW = 8192 # reviewed limit",
      "UNRELATED=preserve-me",
      "MODEL_INPUT_COST_PER_MILLION=0",
      "",
    ].join("\r\n");

    const result = createProfileEnvironmentPatch(before, "policy", profile);
    const after = Buffer.from(result.bytes).toString();

    expect(after).toContain("# owner settings\r\nMODEL_PROVIDER=do-not-change\r\n");
    expect(after).toContain("MODEL_API_KEY=nvapi-SUPER-SECRET\r\n");
    expect(after).toContain("MODEL_CONTEXT_WINDOW = 128000 # reviewed limit\r\n");
    expect(after).toContain("UNRELATED=preserve-me\r\n");
    expect(after).toContain("MODEL_INPUT_COST_PER_MILLION=unknown\r\n");
    expect(after.endsWith("\r\n")).toBe(true);
    expect(after.replaceAll("\r\n", "")).not.toContain("\n");
    expect(result.patch.beforeSha256).toBe(sha256(before));
    expect(result.patch.afterSha256).toBe(sha256(after));
    expect(result.patch.changedKeys).toEqual(result.patch.changes.map((change) => change.key));
    const evidence = JSON.stringify(result.patch);
    expect(evidence).not.toContain("SUPER-SECRET");
    expect(evidence).not.toContain("preserve-me");
    expect(evidence).not.toContain("MODEL_API_KEY");
    expect(evidence).not.toContain("MODEL_PROVIDER");
  });

  it("preserves the absence of a final newline while appending a deterministic block", () => {
    const first = createProfileEnvironmentPatch("# settings\nUNRELATED=yes", "judge", profile);
    const after = Buffer.from(first.bytes).toString();

    expect(after).toContain("\n\n# DocsFab approved judge model profile.\n");
    expect(after.endsWith("\n")).toBe(false);
    expect(after.indexOf("JUDGE_CONTEXT_WINDOW=")).toBeLessThan(
      after.indexOf("JUDGE_MAX_INPUT_TOKENS="),
    );

    const repeat = createProfileEnvironmentPatch(first.bytes, "judge", profile);
    expect(Buffer.from(repeat.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(repeat.patch.changedKeys).toEqual([]);
    expect(repeat.patch.changes).toEqual([]);
    expect(repeat.patch.beforeSha256).toBe(repeat.patch.afterSha256);
  });

  it("updates one prefix without changing existing assignments for the other", () => {
    const before = "JUDGE_CONTEXT_WINDOW=7\nMODEL_CONTEXT_WINDOW=8\n";
    const result = createProfileEnvironmentPatch(before, "policy", profile);
    const after = Buffer.from(result.bytes).toString();
    expect(after).toContain("JUDGE_CONTEXT_WINDOW=7\n");
    expect(after).toContain("MODEL_CONTEXT_WINDOW=128000\n");
    expect(result.patch.changedKeys).not.toContain("JUDGE_CONTEXT_WINDOW");
  });

  it.each([
    "MODEL_CONTEXT_WINDOW=1\nMODEL_CONTEXT_WINDOW=2\n",
    "not an assignment\n",
    "MODEL_CONTEXT_WINDOW=${OTHER}\n",
    "MODEL_API_KEY=$(read-secret)\n",
    "MODEL_API_KEY=`read-secret`\n",
    'MODEL_CONTEXT_WINDOW="unterminated\n',
  ])("rejects ambiguous, malformed, or accessor input without echoing it: %s", (input) => {
    expect(() => createProfileEnvironmentPatch(input, "policy", profile)).toThrow(
      ProfileEnvironmentError,
    );
    try {
      createProfileEnvironmentPatch(input, "policy", profile);
    } catch (error) {
      expect(String(error)).not.toContain(input.trim());
    }
  });

  it("preserves inline comments and assignment formatting when the value is already current", () => {
    const before = "  export MODEL_CONTEXT_WINDOW = 128000   # keep me\n";
    const result = createProfileEnvironmentPatch(before, "policy", profile);
    expect(Buffer.from(result.bytes).toString()).toContain(
      "  export MODEL_CONTEXT_WINDOW = 128000   # keep me\n",
    );
  });

  it("round-trips quoted Unicode, CRLF, mixed replacements, and appended fields exactly", () => {
    const before = [
      "# réglages",
      'MODEL_CONTEXT_WINDOW = "8192" # exact token',
      "MODEL_OUTPUT_COST_PER_MILLION='0'",
      "UNRELATED=préservé",
      "",
    ].join("\r\n");
    const projected = createProfileEnvironmentPatch(before, "policy", profile);
    const restored = createProfileEnvironmentRollback(projected.bytes, projected.patch);
    expect(Buffer.from(restored).equals(Buffer.from(before))).toBe(true);
  });

  it("rejects forged reverse tokens and array getters without invoking them", () => {
    const projected = createProfileEnvironmentPatch(
      "MODEL_CONTEXT_WINDOW=8192\n",
      "policy",
      profile,
    );
    const forged = structuredClone(projected.patch);
    forged.reverse.operations[0]!.beforeToken = "${EVIL}";
    forged.changes[0]!.before = "${EVIL}";
    expect(() => decodeProfileEnvironmentPatch(forged)).toThrow(ProfileEnvironmentError);

    const accessor = structuredClone(projected.patch) as typeof projected.patch;
    const operations: unknown[] = [];
    Object.defineProperty(operations, "0", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE-ARRAY-GETTER-CANARY");
      },
    });
    Object.defineProperty(operations, "length", { value: 1 });
    accessor.reverse.operations = operations as typeof accessor.reverse.operations;
    try {
      decodeProfileEnvironmentPatch(accessor);
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileEnvironmentError);
      expect((error as ProfileEnvironmentError).code).toBe("invalid-profile-environment");
      expect(String(error)).not.toContain("PRIVATE-ARRAY-GETTER-CANARY");
    }
  });

  it("rethrows contract-like decode failures without erasing .code", () => {
    try {
      decodeProfileEnvironmentPatch("{");
      throw new Error("expected JsonEvidenceError");
    } catch (error) {
      expect(error).toBeInstanceOf(JsonEvidenceError);
      expect((error as JsonEvidenceError).code).toBe("malformed-json");
      expect(error).not.toBeInstanceOf(ProfileEnvironmentError);
    }
  });

  it("wraps non-contract decode failures with cause and kebab-case .code", () => {
    const poisoned = new Proxy(
      { schemaVersion: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("PROXY-CANARY");
        },
      },
    );
    try {
      decodeProfileEnvironmentPatch(poisoned);
      throw new Error("expected wrapped ProfileEnvironmentError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileEnvironmentError);
      expect((error as ProfileEnvironmentError).code).toBe("invalid-profile-environment");
      expect((error as ProfileEnvironmentError).cause).toBeInstanceOf(Error);
      expect(String((error as ProfileEnvironmentError).cause)).toContain("PROXY-CANARY");
      expect(String(error)).not.toContain("PROXY-CANARY");
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
