// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_REJECTED_REPLY_SHAPE_DEPTH,
  MAX_REJECTED_REPLY_SHAPE_ENTRIES,
} from "../src/config/inference-rejection-limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import {
  canonicalizeRejectedReplyShape,
  fingerprintRejectedReply,
  REJECTED_REPLY_SHAPE_SCHEMA_VERSION,
  isInferenceRejectedReplyShape,
  UNDECLARED_REPLY_KEY,
} from "../src/execution/rejected-reply-shape.js";
import {
  resolveRejectedReplyShapePolicy,
  retainRejectedReplyShape,
} from "../src/execution/rejected-reply-retention.js";

const policy = () => resolveRejectedReplyShapePolicy();
import {
  isDeclaredResponseContractKey,
  responseContractKeyVocabulary,
} from "../src/execution/response-contract-vocabulary.js";
import {
  formatRejectedReplyShapeClause,
  formatRunRetryDispositionLines,
  readRunRetryDispositions,
} from "../src/operator/retry-disposition.js";
import { migrateLegacyInferenceAttemptEvidence } from "../src/execution/lease-contracts.js";
import type { InferenceAttemptEvidence, RunRecord } from "../src/records/contracts.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";

/** Every key declared, so bound and shape tests exercise the walk alone. */
const anyKey = (): boolean => true;
const fingerprint = (reply: string) =>
  fingerprintRejectedReply(reply, isDeclaredResponseContractKey);
import { executeInferenceStep } from "../src/workflow-execution/retry.js";

// Synthetic values only. Neither is, or resembles, a real credential.
const SENTINEL_PROSE = "SENTINEL-1178 the rejected reply said something private";
const SYNTHETIC_SECRET = `nvapi-${"A1b2C3d4".repeat(5)}`;
const SYNTHETIC_TOKEN_KEY = `ghp_${"Zz09".repeat(8)}`;

describe("rejected reply shape fingerprint (#1178)", () => {
  it("records keys, value types, and lengths without any string content", () => {
    const reply = JSON.stringify({
      review: { verdict: SENTINEL_PROSE, issues: [{ finding: SENTINEL_PROSE }, { finding: "x" }] },
      coverage: [],
      confidence: 3,
      verified: false,
      qualityScore: null,
      [SYNTHETIC_TOKEN_KEY]: SYNTHETIC_SECRET,
      "free text key with spaces": SENTINEL_PROSE,
    });

    const shape = fingerprint(`  ${reply}\n`);

    expect(shape).toMatchObject({
      schemaVersion: 1,
      replyChars: reply.length,
      parse: { status: "parsed" },
      root: "object",
      topLevelKeyCount: 7,
      topLevelKeys: ["review", "coverage", "confidence", "verified", "qualityScore"],
      undeclaredKeys: 2,
    });
    expect(shape.truncation).toBeUndefined();
    expect(shape.paths).toEqual([
      { path: "$", type: "object", count: 1 },
      { path: "$.review", type: "object", count: 1 },
      {
        path: "$.review.verdict",
        type: "string",
        count: 1,
        minLength: SENTINEL_PROSE.length,
        maxLength: SENTINEL_PROSE.length,
      },
      { path: "$.review.issues", type: "array", count: 1, minLength: 2, maxLength: 2 },
      { path: "$.review.issues[]", type: "object", count: 2 },
      {
        path: "$.review.issues[].finding",
        type: "string",
        count: 2,
        minLength: 1,
        maxLength: SENTINEL_PROSE.length,
      },
      { path: "$.coverage", type: "array", count: 1, minLength: 0, maxLength: 0 },
      { path: "$.confidence", type: "number", count: 1 },
      { path: "$.verified", type: "boolean", count: 1 },
      { path: "$.qualityScore", type: "null", count: 1 },
      {
        path: `$.${UNDECLARED_REPLY_KEY}`,
        type: "string",
        count: 2,
        minLength: SYNTHETIC_SECRET.length,
        maxLength: SENTINEL_PROSE.length,
      },
    ]);
    const serialized = JSON.stringify(shape);
    for (const content of [
      SENTINEL_PROSE,
      "SENTINEL",
      SYNTHETIC_SECRET,
      "nvapi-",
      SYNTHETIC_TOKEN_KEY,
      "free text",
    ]) {
      expect(serialized).not.toContain(content);
    }
    expect(isInferenceRejectedReplyShape(shape)).toBe(true);
  });

  it("states where and how the strict parser stopped on a reply that is not JSON", () => {
    const reply = `{"review": {"verdict": "${SENTINEL_PROSE}"`;
    expect(fingerprintRejectedReply(reply, anyKey)).toEqual({
      schemaVersion: 1,
      replyChars: reply.length,
      parse: {
        status: "failed",
        code: "malformed-json",
        detail: "unexpected-end",
        offset: reply.length,
      },
      undeclaredKeys: 0,
      paths: [],
    });
    const fenced = "```json\n{}\n```";
    expect(fingerprintRejectedReply(fenced, anyKey).parse).toEqual({
      status: "failed",
      code: "malformed-json",
      detail: "unexpected-token",
      offset: 0,
    });
    const duplicate = '{"a":1,"a":2}';
    expect(fingerprintRejectedReply(duplicate, anyKey).parse).toMatchObject({
      status: "failed",
      code: "duplicate-key",
    });
  });

  it("describes nesting only to the catalog depth and states what it left out", () => {
    const depth = MAX_REJECTED_REPLY_SHAPE_DEPTH + 2;
    let value: unknown = { leaf: SENTINEL_PROSE };
    for (let level = 0; level < depth; level += 1) value = { nested: value };

    const shape = fingerprintRejectedReply(JSON.stringify(value), anyKey);

    const deepest = Math.max(...shape.paths.map((entry) => entry.path.split(".").length - 1));
    expect(deepest).toBe(MAX_REJECTED_REPLY_SHAPE_DEPTH);
    expect(shape.truncation).toEqual([
      {
        limit: "inference.rejectedReplyShapeMaxDepth",
        bound: MAX_REJECTED_REPLY_SHAPE_DEPTH,
        scope: "containers",
        omitted: 1,
      },
    ]);
    expect(isInferenceRejectedReplyShape(shape)).toBe(true);
  });

  it("lists at most the catalog entry bound of paths and top-level keys, counting the rest", () => {
    const extra = 5;
    const keys = Array.from(
      { length: MAX_REJECTED_REPLY_SHAPE_ENTRIES + extra },
      (_, index) => `key${index}`,
    );
    const shape = fingerprintRejectedReply(
      JSON.stringify(Object.fromEntries(keys.map((key) => [key, SENTINEL_PROSE]))),
      anyKey,
    );

    expect(shape.paths).toHaveLength(MAX_REJECTED_REPLY_SHAPE_ENTRIES);
    expect(shape.topLevelKeys).toHaveLength(MAX_REJECTED_REPLY_SHAPE_ENTRIES);
    expect(shape.topLevelKeyCount).toBe(keys.length);
    expect(shape.truncation).toEqual([
      {
        limit: "inference.rejectedReplyShapeMaxEntries",
        bound: MAX_REJECTED_REPLY_SHAPE_ENTRIES,
        scope: "paths",
        // The root plus the listed keys fill the bound; the remaining keys'
        // paths are counted, not dropped.
        omitted: keys.length + 1 - MAX_REJECTED_REPLY_SHAPE_ENTRIES,
      },
      {
        limit: "inference.rejectedReplyShapeMaxEntries",
        bound: MAX_REJECTED_REPLY_SHAPE_ENTRIES,
        scope: "top-level-keys",
        omitted: extra,
      },
    ]);
    expect(isInferenceRejectedReplyShape(shape)).toBe(true);
  });

  it("reads both bounds from config/limits.yaml", () => {
    expect(MAX_REJECTED_REPLY_SHAPE_DEPTH).toBe(
      LIMIT_DEFINITION_BY_NAME["inference.rejectedReplyShapeMaxDepth"]!.value,
    );
    expect(MAX_REJECTED_REPLY_SHAPE_ENTRIES).toBe(
      LIMIT_DEFINITION_BY_NAME["inference.rejectedReplyShapeMaxEntries"]!.value,
    );
  });

  it("refuses a forged fingerprint that could carry reply text", () => {
    const valid = fingerprint('{"review":{"verdict":"pass"}}');
    const forged: unknown[] = [
      { ...valid, text: SENTINEL_PROSE },
      { ...valid, topLevelKeys: [SENTINEL_PROSE] },
      {
        ...valid,
        paths: [
          { path: `$.${SENTINEL_PROSE}`, type: "string", count: 1, minLength: 1, maxLength: 1 },
        ],
      },
      { ...valid, paths: [{ path: "$.review[3]", type: "object", count: 1 }] },
      { ...valid, paths: [{ path: "$.review.verdict", type: "string", count: 1 }] },
      { ...valid, paths: [{ path: "$", type: "object", count: 1, sample: SENTINEL_PROSE }] },
      {
        ...valid,
        paths: [
          {
            path: `$${".a".repeat(LIMIT_DEFINITION_BY_NAME["inference.rejectedReplyShapeMaxDepth"]!.max + 1)}`,
            type: "object",
            count: 1,
          },
        ],
      },
      { ...valid, parse: { status: "failed", code: "malformed-json", detail: SENTINEL_PROSE } },
      { ...valid, truncation: [{ limit: "other", bound: 1, scope: "paths", omitted: 1 }] },
    ];
    for (const value of forged) expect(isInferenceRejectedReplyShape(value)).toBe(false);
  });
});

describe("rejected reply shape retention (#1178)", () => {
  it("attaches a fingerprint only to a response-contract rejection, keeping the error object", () => {
    const rejected = new InferenceStepError("rejected", "malformed-response", true);
    expect(retainRejectedReplyShape(rejected, '{"review":1,"a":1}', policy())).toBe(rejected);
    // "a" is declared by no host response contract, so it is counted, not named.
    expect(rejected.rejectedReplyShape).toMatchObject({
      topLevelKeys: ["review"],
      topLevelKeyCount: 2,
      undeclaredKeys: 1,
    });

    const provider = new InferenceStepError("down", "provider-transient", true);
    retainRejectedReplyShape(provider, '{"a":1}', policy());
    expect(provider.rejectedReplyShape).toBeUndefined();

    const unseen = new InferenceStepError("rejected", "malformed-response", true);
    retainRejectedReplyShape(unseen, undefined, policy());
    expect(unseen.rejectedReplyShape).toBeUndefined();
  });

  it("copies the fingerprint and a redacted excerpt onto the attempt record, never the credential", async () => {
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      execute: async () => {
        const error = new InferenceStepError("rejected", "malformed-response", true, undefined, {
          code: "invalid-review",
          location: "$.review",
        });
        throw retainRejectedReplyShape(
          error,
          JSON.stringify({ review: SENTINEL_PROSE, secret: SYNTHETIC_SECRET }),
          policy(),
        );
      },
    });

    expect(execution.status).toBe("failed");
    expect(execution.evidence.attempts).toHaveLength(1);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "malformed-response",
      rejection: { code: "invalid-review", location: "$.review" },
      rejectedReplyShape: { root: "object", topLevelKeys: ["review"], undeclaredKeys: 1 },
    });
    const [attempt] = execution.evidence.attempts;
    // The fingerprint stays content-free; the prose is kept only in the excerpt.
    expect(JSON.stringify(attempt!.rejectedReplyShape)).not.toContain("SENTINEL");
    expect(attempt!.rejectedReplyExcerpt).toMatchObject({ omittedChars: 0, redactions: 1 });
    expect(attempt!.rejectedReplyExcerpt!.segments[0]!.text).toContain(SENTINEL_PROSE);
    const record = JSON.stringify(execution.evidence);
    expect(record).not.toContain(SYNTHETIC_SECRET);
    expect(record).not.toContain('"secret"');
  });
});

// Identifier-shaped keys a model could use to carry content. Synthetic values.
const PRIVATE_KEYS = [
  "0123456789abcdef0123456789abcdef01234567".replace(/^0/u, "a"),
  "Q9vX2mLp7RtK4wZs8NbY3cHd6FgJ1eUa",
  "the_customer_password_is_Tr0ub4dor3",
] as const;

describe("response-contract key vocabulary (#1178)", () => {
  it("is derived from the decoders and schemas, and declares none of the private keys", () => {
    const vocabulary = responseContractKeyVocabulary();
    for (const key of [
      "review",
      "coverage",
      "factInventory",
      "verificationResult",
      "obligationAccounting",
      "issueJudgments",
      "obligationJudgments",
      "editorialAssessmentProposal",
      "qualityScore",
      "reportMarkdown",
      "overall_decision",
      "required_change",
    ]) {
      expect(vocabulary.has(key)).toBe(true);
    }
    expect(PRIVATE_KEYS[0]).toMatch(/^[a-f0-9]{40}$/u);
    expect(PRIVATE_KEYS[1]).toMatch(/^[A-Za-z0-9]{32}$/u);
    for (const key of PRIVATE_KEYS) expect(vocabulary.has(key)).toBe(false);
  });

  it("matches its generated JSON mirror, which non-TypeScript readers use", () => {
    const mirror = JSON.parse(
      readFileSync(
        new URL("../src/execution/response-contract-vocabulary.generated.json", import.meta.url),
        "utf8",
      ),
    ) as { keys: string[]; rejectedReplyShapeSchemaVersion: number };
    expect(mirror.keys).toEqual([...responseContractKeyVocabulary()].sort());
    expect(mirror.rejectedReplyShapeSchemaVersion).toBe(REJECTED_REPLY_SHAPE_SCHEMA_VERSION);
  });

  it("counts identifier-shaped private keys as undeclared and never names them", () => {
    const reply = JSON.stringify({
      review: { verdict: "pass", [PRIVATE_KEYS[2]]: 1 },
      [PRIVATE_KEYS[0]]: 1,
      [PRIVATE_KEYS[1]]: { nested: true },
      [PRIVATE_KEYS[2]]: [],
    });
    const shape = fingerprint(reply);
    expect(shape).toMatchObject({
      topLevelKeyCount: 4,
      topLevelKeys: ["review"],
      undeclaredKeys: 5,
    });
    const clause = formatRejectedReplyShapeClause(shape);
    expect(clause).toBe("reply keys review (+3 undeclared)");
    for (const surface of [JSON.stringify(shape), clause]) {
      for (const key of PRIVATE_KEYS) expect(surface).not.toContain(key);
      expect(surface).not.toContain("Tr0ub4dor3");
    }
  });

  it("states keys hidden for privacy apart from keys and paths cut by bounds", () => {
    const keys = Array.from({ length: 3 }, (_, index) => `k${index}`);
    const nested = { a: { b: { c: 1 } } };
    const shape = fingerprintRejectedReply(
      JSON.stringify({ ...Object.fromEntries(keys.map((key) => [key, nested])) }),
      (key) => key !== "k2",
    );
    const clipped = {
      ...shape,
      topLevelKeys: [],
      truncation: [
        {
          limit: "inference.rejectedReplyShapeMaxEntries",
          bound: 2,
          scope: "top-level-keys",
          omitted: 2,
        },
        {
          limit: "inference.rejectedReplyShapeMaxDepth",
          bound: 2,
          scope: "containers",
          omitted: 4,
        },
      ],
    } as typeof shape;
    expect(formatRejectedReplyShapeClause(clipped)).toBe(
      "reply keys none (+1 undeclared, +2 over limit); reply shape truncated (4 containers past inference.rejectedReplyShapeMaxDepth = 2)",
    );
  });

  it("refuses a failed-parse fingerprint whose detail is outside the parser vocabulary", () => {
    const failed = fingerprintRejectedReply('{"review":', anyKey);
    expect(isInferenceRejectedReplyShape(failed)).toBe(true);
    expect(
      isInferenceRejectedReplyShape({
        ...failed,
        parse: { ...failed.parse, detail: "SENTINEL-free-text" },
      }),
    ).toBe(false);
  });
});

// A grammar-valid identifier matching the repository's GitHub token rule.
// Synthetic; not a credential.
const CREDENTIAL_SHAPED_KEY = `ghp_${"Zz09".repeat(9)}`;

describe("rejected reply shape readers (#1178)", () => {
  const valid = () => fingerprintRejectedReply('{"review":{"verdict":"pass"}}', anyKey);

  it("refuses a forged credential-shaped top-level key or nested path segment", () => {
    const forgedTop = { ...valid(), topLevelKeys: ["review", CREDENTIAL_SHAPED_KEY] };
    const forgedNested = {
      ...valid(),
      paths: [{ path: `$.review.${CREDENTIAL_SHAPED_KEY}`, type: "number", count: 1 }],
    };
    for (const forged of [forgedTop, forgedNested]) {
      expect(isInferenceRejectedReplyShape(forged)).toBe(false);
      const attempt = {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
        durationMs: 1,
        rejectedReplyShape: forged,
      } as unknown as InferenceAttemptEvidence;
      expect(() => migrateLegacyInferenceAttemptEvidence(attempt)).toThrow();
      const record = {
        steps: [
          { id: "verify-technical-accuracy", status: "failed", inference: { attempts: [attempt] } },
        ],
      } as unknown as RunRecord;
      expect(readRunRetryDispositions(record)[0]?.rejectedReplyShape).toBeUndefined();
      expect(formatRunRetryDispositionLines(record).join("\n")).not.toContain(
        CREDENTIAL_SHAPED_KEY,
      );
    }
  });

  it("canonicalizes a stored undeclared key before any operator surface reads it", () => {
    const hexKey = "a123456789abcdef0123456789abcdef01234567";
    const stored = fingerprintRejectedReply(
      JSON.stringify({ review: { [hexKey]: "x" }, [hexKey]: { verdict: 1 } }),
      anyKey,
    );
    expect(JSON.stringify(stored)).toContain(hexKey);
    const record = {
      steps: [
        {
          id: "verify-technical-accuracy",
          status: "failed",
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "malformed-response",
                retryable: true,
                retryScheduled: false,
                durationMs: 1,
                rejectedReplyShape: stored,
              },
            ],
          },
        },
      ],
    } as unknown as RunRecord;
    const reading = readRunRetryDispositions(record)[0]!;
    expect(reading.rejectedReplyShape?.topLevelKeys).toEqual(["review"]);
    for (const surface of [
      JSON.stringify(reading),
      formatRunRetryDispositionLines(record).join("\n"),
    ]) {
      expect(surface).not.toContain(hexKey);
    }
    const canonical = canonicalizeRejectedReplyShape(stored, isDeclaredResponseContractKey);
    expect(canonical.paths.map((entry) => entry.path)).toContain("$.<undeclared>");
    expect(isInferenceRejectedReplyShape(canonical)).toBe(true);
  });
});

describe("string array members never reach the fingerprint or an operator surface (#1178)", () => {
  // Synthetic members only. Identifier-shaped (including the declared key
  // `review`), prose, and credential-shaped strings, in flat and nested arrays
  // and in string arrays inside arrays of objects, at several depths.
  const IDENTIFIER_MEMBERS = [
    "customer_password_Tr0ub4dor3",
    "SyntheticPrivateNote",
    "DeepNote_1178",
  ];
  const PROSE_MEMBER = "SENTINEL-1178 array member prose";
  const CREDENTIAL_MEMBER = `ghp_${"Aa11".repeat(9)}`;
  const reply = JSON.stringify({
    review: { verdict: "pass", issues: [] },
    coverage: [
      {
        path: "docs/a.md",
        status: "verified",
        evidence: ["customer_password_Tr0ub4dor3", "review", PROSE_MEMBER],
        reason: "r",
      },
    ],
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: [
        {
          dimension: "d",
          status: "applicable",
          reason: "r",
          sourceLocators: [],
          facts: [{ id: "F", issueIds: ["SyntheticPrivateNote", CREDENTIAL_MEMBER] }],
        },
      ],
      limitations: [["DeepNote_1178", ["review", PROSE_MEMBER]], CREDENTIAL_MEMBER],
    },
  });
  const members = [...IDENTIFIER_MEMBERS, PROSE_MEMBER, CREDENTIAL_MEMBER];

  it("writes only `[]` for array members, never a member string, at any depth", () => {
    const shape = fingerprint(reply);
    const serialized = JSON.stringify(shape);
    for (const member of members) expect(serialized).not.toContain(member);
    const paths = shape.paths.map((entry) => entry.path);
    // No path segment may come from a member: every segment below an array is `[]`
    // or a declared object key, so `review` appears only as the top-level key.
    expect(paths.filter((path) => path.includes(".review"))).toEqual(
      paths.filter((path) => path.startsWith("$.review")),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "$.coverage[].evidence[]",
        "$.factInventory.dimensions[].facts[].issueIds[]",
        "$.factInventory.limitations[]",
        "$.factInventory.limitations[][]",
        "$.factInventory.limitations[][][]",
      ]),
    );
    for (const path of paths) {
      for (const member of members) expect(path).not.toContain(member);
    }
    expect(isInferenceRejectedReplyShape(shape)).toBe(true);
  });

  it("keeps every member off the footer, RETRIES, and `--json` readings", () => {
    const attempt = {
      attempt: 1,
      outcome: "malformed-response",
      retryable: true,
      retryScheduled: false,
      durationMs: 1,
      rejection: { code: "invalid-review", location: "$.review" },
      rejectedReplyShape: fingerprint(reply),
    };
    const record = {
      id: "array-members",
      status: "failed",
      error: "Technical review response rejected: invalid-review.",
      steps: [
        {
          id: "verify-technical-accuracy",
          status: "failed",
          error: "Technical review response rejected: invalid-review.",
          inference: { attempts: [attempt] },
        },
      ],
    } as unknown as RunRecord;
    const surfaces = {
      record: JSON.stringify(record),
      footer: formatRunFailureDiagnosticLines(record).join("\n"),
      retries: formatRunRetryDispositionLines(record).join("\n"),
      json: JSON.stringify(readRunRetryDispositions(record)),
    };
    for (const [name, surface] of Object.entries(surfaces)) {
      for (const member of members)
        expect(surface, `${name} names ${member}`).not.toContain(member);
    }
  });
});

describe("operator key layers are each pinned (#1178)", () => {
  const hexKey = "a123456789abcdef0123456789abcdef01234567";
  // A stored fingerprint that names an undeclared key, as an older build or a
  // hand edit could write it. Not rewritten: each layer is exercised alone.
  const stored = () =>
    fingerprintRejectedReply(JSON.stringify({ review: 1, [hexKey]: { verdict: 1 } }), anyKey);

  it("the clause filter alone keeps an undeclared key off the operator line", () => {
    const clause = formatRejectedReplyShapeClause(stored());
    expect(clause).toBe("reply keys review (+1 undeclared)");
    expect(clause).not.toContain(hexKey);
  });

  it("the key rewrite alone removes an undeclared key from keys and paths", () => {
    const canonical = canonicalizeRejectedReplyShape(stored(), isDeclaredResponseContractKey);
    expect(canonical.topLevelKeys).toEqual(["review"]);
    expect(canonical.undeclaredKeys).toBe(1);
    expect(JSON.stringify(canonical)).not.toContain(hexKey);
    expect(canonical.paths.map((entry) => entry.path)).toEqual([
      "$",
      "$.review",
      "$.<undeclared>",
      "$.<undeclared>.verdict",
    ]);
  });
});

describe("rejected reply shape bounds resolve through limit() (#1178)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies a validated host environment override and refuses one out of range", () => {
    vi.stubEnv("DOCSFAB_INFERENCE_REJECTED_REPLY_SHAPE_MAX_DEPTH", "1");
    const nested = new InferenceStepError("rejected", "malformed-response", true);
    retainRejectedReplyShape(
      nested,
      '{"review":{"verdict":"pass"}}',
      resolveRejectedReplyShapePolicy(),
    );
    expect(nested.rejectedReplyShape?.truncation).toEqual([
      {
        limit: "inference.rejectedReplyShapeMaxDepth",
        bound: 1,
        scope: "containers",
        omitted: 1,
      },
    ]);

    vi.stubEnv("DOCSFAB_INFERENCE_REJECTED_REPLY_SHAPE_MAX_DEPTH", "33");
    // Refused when the policy is resolved, before any attempt -- never on the
    // rejection path, where it would replace the original error.
    expect(() => resolveRejectedReplyShapePolicy()).toThrow(
      "DOCSFAB_INFERENCE_REJECTED_REPLY_SHAPE_MAX_DEPTH must be an integer between 1 and 32.",
    );
  });
});
