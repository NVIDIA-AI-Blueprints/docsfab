// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { serializeRunResultCliJson } from "../src/cli/run/delivery.js";

import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { migrateLegacyInferenceAttemptEvidence } from "../src/execution/lease-contracts.js";
import {
  excerptRejectedReply,
  isInferenceRejectedReplyExcerpt,
  isRejectedReplyExcerptOf,
  projectRejectedReplyExcerpt,
  REJECTED_REPLY_EXCERPT_REDACTION,
  type InferenceRejectedReplyExcerptV1,
} from "../src/execution/rejected-reply-excerpt.js";
import {
  resolveRejectedReplyShapePolicy,
  retainRejectedReplyShape,
} from "../src/execution/rejected-reply-retention.js";
import { fingerprintRejectedReply } from "../src/execution/rejected-reply-shape.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import {
  formatRejectedReplyExcerptLines,
  formatRunRetryDispositionLines,
  readRunRetryDispositions,
} from "../src/operator/retry-disposition.js";
import type { RunResultV1 } from "../src/operator/run-result.js";
import type { InferenceAttemptEvidence, RunRecord } from "../src/records/contracts.js";
import { projectRunIndexRows, type RunIndexRowV1 } from "../src/records/run-index.js";
import { hostRootSet } from "../src/security/egress.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";
import { containsTextCredentialShape } from "../src/security/text-credential-shapes.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

const BOUND = LIMIT_DEFINITION_BY_NAME["inference.rejectedReplyExcerptChars"]!.value;
const CEILING = LIMIT_DEFINITION_BY_NAME["inference.rejectedReplyExcerptChars"]!.max;
/** `length` characters of prose ending in a period, so trimming never shortens it. */
const filler = (length: number, word = "prose "): string =>
  `${word.repeat(Math.ceil(length / word.length)).slice(0, length - 1)}.`;
const texts = (excerpt: InferenceRejectedReplyExcerptV1): string =>
  excerpt.segments.map((segment) => segment.text).join("\n");

// Synthetic credential-shaped values. None is, or resembles, a real credential.
const CREDENTIALS: ReadonlyArray<readonly [string, string, string]> = [
  ["NVIDIA API key", `nvapi-${"Qw12".repeat(6)}`, "The key nvapi-"],
  ["metadata API token", `ihub_api_${"Er34".repeat(6)}`, "token ihub_api_"],
  ["GitHub token", `ghp_${"Ty56".repeat(9)}`, "see ghp_"],
  ["GitHub fine-grained token", `github_pat_${"Ui78".repeat(6)}`, "use github_pat_"],
  ["GitLab token", `glpat-${"Op90".repeat(6)}`, "push with glpat-"],
  ["Slack token", `xoxb-${"As12".repeat(6)}`, "bot xoxb-"],
  ["OpenAI key", `sk-proj-${"Df34".repeat(6)}`, "key sk-proj-"],
  ["AWS access key id", `AKIA${"GH56JK78LZ90QW12"}`, "id AKIA"],
  ["bearer value", `Bearer ${"Zx90Cv12Bn34Mm56"}`, "Authorization Bearer"],
  ["JWT", `eyJ${"hbGciOi".repeat(2)}.eyJ${"zdWIiOi".repeat(2)}.${"SflKxw".repeat(3)}`, "jwt eyJ"],
  ["assigned client secret", `client_secret: "${"Rt78Yu90".repeat(3)}"`, "client_secret"],
  ["assigned password", `password=${"Hj12Kl34".repeat(3)}`, "password="],
];

describe("rejected reply excerpt segments (#1690)", () => {
  it("keeps a short reply whole in the head", () => {
    const excerpt = excerptRejectedReply("  I cannot answer in JSON.\n", BOUND, 0);
    expect(excerpt).toEqual({
      schemaVersion: 1,
      replyChars: 24,
      parseOffset: 0,
      segments: [{ role: "head", start: 0, end: 24, text: "I cannot answer in JSON." }],
      omittedChars: 0,
      redactions: 0,
      limit: "inference.rejectedReplyExcerptChars",
      bound: BOUND,
    });
    expect(isInferenceRejectedReplyExcerpt(excerpt)).toBe(true);
  });

  it("keeps head, tail, and a window at a mid-reply parse position, and counts the rest", () => {
    const reply = `${filler(3000)}{"broken":}${filler(3000)}`;
    const excerpt = excerptRejectedReply(reply, 100, 3010);
    expect(excerpt.segments.map(({ role, start, end }) => [role, start, end])).toEqual([
      ["head", 0, 100],
      ["parse-position", 2960, 3060],
      ["tail", reply.length - 100, reply.length],
    ]);
    expect(excerpt.segments[1]!.text).toContain('{"broken":}');
    expect(excerpt.omittedChars).toBe(reply.length - 300);
    expect(isInferenceRejectedReplyExcerpt(excerpt)).toBe(true);
  });

  it("adds no window when the parse position is inside the head or tail", () => {
    const reply = filler(1000);
    for (const offset of [0, 99, 950, 1000]) {
      expect(excerptRejectedReply(reply, 100, offset).segments.map((s) => s.role)).toEqual([
        "head",
        "tail",
      ]);
    }
  });

  it("splits a reply of at most twice the bound into contiguous head and tail", () => {
    const excerpt = excerptRejectedReply(filler(150), 100);
    expect(excerpt.segments.map(({ role, start, end }) => [role, start, end])).toEqual([
      ["head", 0, 100],
      ["tail", 100, 150],
    ]);
    expect(excerpt.omittedChars).toBe(0);
  });

  it("keeps no text at bound 0 and still states the reply length", () => {
    const excerpt = excerptRejectedReply(filler(500), 0, 7);
    expect(excerpt).toMatchObject({ replyChars: 500, segments: [], omittedChars: 500, bound: 0 });
    expect(formatRejectedReplyExcerptLines(excerpt)).toEqual([
      "Reply excerpt: 0 of 500 characters retained; 500 not retained past inference.rejectedReplyExcerptChars = 0 per segment; parse stopped at character 7 (not retained).",
    ]);
  });
});

describe("rejected reply excerpt redaction (#1690)", () => {
  it.each(CREDENTIALS)(
    "redacts the %s credential shape wherever it sits in the reply",
    (_name, secret, lead) => {
      for (const reply of [
        `${lead} ${secret} before the answer.`,
        `${filler(400)} ${lead} ${secret} ${filler(400)}`,
        `${filler(1500)} ${lead} ${secret} ${filler(1500)}`,
        `${filler(1500)} ${lead} ${secret}`,
      ]) {
        const excerpt = excerptRejectedReply(reply, BOUND, reply.indexOf(secret));
        const retained = texts(excerpt);
        expect(retained).toContain(REJECTED_REPLY_EXCERPT_REDACTION);
        expect(retained).not.toContain(secret);
        expect(detectCredentialRuleIds(retained)).toEqual([]);
        expect(containsTextCredentialShape(retained)).toBe(false);
        expect(excerpt.redactions).toBeGreaterThan(0);
        expect(isInferenceRejectedReplyExcerpt(excerpt)).toBe(true);
      }
    },
  );

  it("redacts DocsFab's own configured credential, and a piece of it, though neither looks like a credential (#1807)", () => {
    const credential = configureCredential(["harbor", plantedCredentialValue(86, 24)].join("-"));
    const piece = credential.slice(3, 21);
    const reply = `The setting is ${credential}, and its middle reads ${piece}.`;
    const excerpt = excerptRejectedReply(reply, BOUND);
    expect(texts(excerpt)).toBe(
      `The setting is ${REJECTED_REPLY_EXCERPT_REDACTION}, and its middle reads ${REJECTED_REPLY_EXCERPT_REDACTION}.`,
    );
    expect(excerpt.redactions).toBe(2);
    // The same text with a value that is not configured is kept as written.
    const other = ["harbor", plantedCredentialValue(87, 24)].join("-");
    expect(texts(excerptRejectedReply(`The setting is ${other}.`, BOUND))).toBe(
      `The setting is ${other}.`,
    );
  });

  it("redacts a whole private-key block, not only its banner", () => {
    // Built at run time so the source holds no complete key block.
    const banner = (edge: string) => `-----${edge} PRIVATE KEY-----`;
    const body = "fixtureOnlyNotAKey".repeat(4);
    const reply = `Here is the key:\n${banner("BEGIN")}\n${body}\n${banner("END")}\nDone.`;
    const retained = texts(excerptRejectedReply(reply, BOUND));
    expect(retained).toBe(`Here is the key:\n${REJECTED_REPLY_EXCERPT_REDACTION}\nDone.`);
  });

  it("redacts a private-key block that is cut off before its END line", () => {
    const banner = `-----${"BEGIN"} PRIVATE KEY-----`;
    const reply = `Here is the key:\n${banner}\n${"fixtureOnlyNotAKey".repeat(4)}`;
    expect(texts(excerptRejectedReply(reply, BOUND))).toBe(
      `Here is the key:\n${REJECTED_REPLY_EXCERPT_REDACTION}`,
    );
  });

  it("redacts a whole JWT, signature included", () => {
    const signature = "Sg12Sg34Sg56Sg78";
    const token = `eyJ${"hbGciOi".repeat(2)}.eyJ${"zdWIiOi".repeat(2)}.${signature}`;
    const retained = texts(excerptRejectedReply(`Sent ${token} as the header.`, BOUND));
    expect(retained).toBe(`Sent ${REJECTED_REPLY_EXCERPT_REDACTION} as the header.`);
    expect(retained).not.toContain(signature);
  });

  it("redacts back-to-back JWTs, each with its signature", () => {
    const token = (tag: string) =>
      `eyJ${"hbGciOi".repeat(2)}.eyJ${"zdWIiOi".repeat(2)}.Sg${tag}Sg34Sg56Sg78`;
    const marker = REJECTED_REPLY_EXCERPT_REDACTION;
    for (const [joined, expected] of [
      [`${token("A1")}${token("B2")}`, marker],
      [`${token("A1")}.${token("B2")}`, `${marker}.${marker}`],
    ] as const) {
      const retained = texts(excerptRejectedReply(`Sent ${joined} as the header.`, BOUND));
      expect(retained).toBe(`Sent ${expected} as the header.`);
    }
  });

  it("redacts a PGP private-key block", () => {
    const banner = (edge: string) => `-----${edge} PGP PRIVATE KEY BLOCK-----`;
    const reply = `Key:\n${banner("BEGIN")}\n${"fixtureOnlyNotAKey".repeat(4)}\n${banner("END")}\nDone.`;
    expect(texts(excerptRejectedReply(reply, BOUND))).toBe(
      `Key:\n${REJECTED_REPLY_EXCERPT_REDACTION}\nDone.`,
    );
  });

  it("redacts URL userinfo for any scheme and a Basic authorization value", () => {
    const password = "Pw12Pw34";
    const reply =
      `Connect to postgres://svc:${password}@db.internal/app and redis://:${password}@cache:6379; ` +
      `send Authorization: Basic ${"c3ZjOlB3MTJQ"}dzM0 to the proxy.`;
    const retained = texts(excerptRejectedReply(reply, BOUND));
    expect(retained).not.toContain(password);
    expect(retained).not.toContain("c3ZjOlB3MTJQ");
    expect(retained).toContain(`${REJECTED_REPLY_EXCERPT_REDACTION}db.internal/app`);
    expect(retained).toContain(`send ${REJECTED_REPLY_EXCERPT_REDACTION} to the proxy.`);
  });

  it("redacts home-directory paths and URLs that could carry identifiers or tokens", () => {
    const reply =
      "Read /home/bob/.config/app.toml and https://user:hunter2@internal.example/path?t=abc then answer.";
    expect(texts(excerptRejectedReply(reply, BOUND))).toBe(
      `Read ${REJECTED_REPLY_EXCERPT_REDACTION} and ${REJECTED_REPLY_EXCERPT_REDACTION} then answer.`,
    );
  });

  it("leaves no fragment of a credential that a segment edge cuts through", () => {
    const secret = `nvapi-${"Ab12".repeat(10)}`;
    // The key starts a few characters before the head ends and ends a few
    // characters after the tail starts in a reply only a little longer.
    const across = `${filler(BOUND - 5)}${secret}${filler(BOUND)}`;
    const head = excerptRejectedReply(across, BOUND).segments[0]!;
    expect(head.text.endsWith(REJECTED_REPLY_EXCERPT_REDACTION)).toBe(true);
    expect(head.text).not.toContain("nvap");
    const tailCut = `${filler(BOUND * 3)}${secret}${filler(BOUND - 10)}`;
    const tail = excerptRejectedReply(tailCut, BOUND).segments.at(-1)!;
    expect(tail.role).toBe("tail");
    expect(tail.text.startsWith(REJECTED_REPLY_EXCERPT_REDACTION)).toBe(true);
    expect(tail.text).not.toMatch(/Ab12/u);
  });

  it("redacts an assigned value whose key lies outside the segment", () => {
    const value = "Qp81Zm92Xn03Wl14Vk25";
    const reply = `${filler(BOUND * 3)}api_key = "${value}" and more ${filler(BOUND - 30)}`;
    const excerpt = excerptRejectedReply(reply, BOUND);
    const tail = excerpt.segments.at(-1)!;
    expect(tail.start).toBeGreaterThan(reply.indexOf("api_key"));
    expect(tail.text).not.toContain(value.slice(-8));
  });

  it("withholds a segment the canonical screen still matches, and says so", () => {
    // A Google API key shape is caught by the repository scanner, not by a span rule.
    const reply = `Use AIza${"Sy0123456789abcdefghijklmnopqrstuvw"} to call the API.`;
    const excerpt = excerptRejectedReply(reply, BOUND);
    expect(excerpt.segments).toEqual([
      { role: "head", start: 0, end: reply.length, text: "", withheld: "credential-material" },
    ]);
    expect(excerpt.redactions).toBe(0);
    expect(isInferenceRejectedReplyExcerpt(excerpt)).toBe(true);
    expect(formatRejectedReplyExcerptLines(excerpt)).toEqual([
      `Reply excerpt: ${reply.length} of ${reply.length} characters retained.`,
      `  head 0-${reply.length}: withheld (credential-material)`,
    ]);
  });
});

describe("rejected reply excerpt records and display (#1690)", () => {
  const reply = `${filler(1200, "reasoning ")}\n{"review":`;
  const shape = fingerprintRejectedReply(reply, () => true);
  const offset = shape.parse.status === "failed" ? shape.parse.offset : undefined;
  const excerpt = excerptRejectedReply(reply, BOUND, offset);

  it("admits the written excerpt beside its fingerprint and refuses a mismatched one", () => {
    expect(isRejectedReplyExcerptOf(excerpt, shape)).toBe(true);
    expect(isRejectedReplyExcerptOf(excerpt, undefined)).toBe(false);
    expect(
      isRejectedReplyExcerptOf({ ...excerpt, replyChars: excerpt.replyChars + 1 }, shape),
    ).toBe(false);
    expect(isRejectedReplyExcerptOf({ ...excerpt, parseOffset: 3 }, shape)).toBe(false);
  });

  it("is admitted by the attempt migration reader only beside its fingerprint", () => {
    const attempt = (extra: Record<string, unknown>) =>
      ({
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
        durationMs: 1,
        ...extra,
      }) as unknown as InferenceAttemptEvidence;
    expect(() =>
      migrateLegacyInferenceAttemptEvidence(
        attempt({ rejectedReplyShape: shape, rejectedReplyExcerpt: excerpt }),
      ),
    ).not.toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence(attempt({ rejectedReplyExcerpt: excerpt })),
    ).toThrow();
  });

  it("refuses forged excerpts that could smuggle text or misstate truncation", () => {
    const head = excerpt.segments[0]!;
    const forged: unknown[] = [
      { ...excerpt, extra: "reply prose" },
      { ...excerpt, schemaVersion: 2 },
      { ...excerpt, limit: "inference.other" },
      { ...excerpt, bound: -1 },
      { ...excerpt, bound: 1.5 },
      { ...excerpt, omittedChars: 0 },
      { ...excerpt, segments: [{ ...head, text: head.text + filler(BOUND) }] },
      { ...excerpt, segments: [{ ...head, end: head.start + excerpt.bound + 1 }] },
      { ...excerpt, segments: [{ ...head, note: "x" }] },
      { ...excerpt, segments: [head, head] },
      { ...excerpt, segments: [...excerpt.segments].reverse() },
      { ...excerpt, segments: [{ ...head, text: "x", withheld: "credential-material" }] },
      {
        ...excerpt,
        segments: [{ ...head, text: "half a pair \uD83D" }, ...excerpt.segments.slice(1)],
      },
      { ...excerpt, segments: [{ ...head, role: "middle" }] },
    ];
    for (const value of forged) expect(isInferenceRejectedReplyExcerpt(value)).toBe(false);
  });

  it("replaces this host's roots on display and withholds a hand-edited credential", () => {
    const roots = hostRootSet([{ kind: "state", path: "/srv/docsfab-state" }], {
      platform: "linux",
    });
    const stored: InferenceRejectedReplyExcerptV1 = {
      ...excerpt,
      segments: [
        { ...excerpt.segments[0]!, text: "read /srv/docsfab-state/run.json first" },
        { ...excerpt.segments[1]!, text: `token nvapi-${"Mn34".repeat(6)}` },
      ],
    };
    const projected = projectRejectedReplyExcerpt(stored, roots);
    expect(projected.segments[0]!.text).toBe("read $DOCSFAB_STATE_DIR/run.json first");
    expect(projected.segments[1]).toMatchObject({
      text: `token ${REJECTED_REPLY_EXCERPT_REDACTION}`,
    });
    expect(isRejectedReplyExcerptOf(projected, shape, { projected: true })).toBe(true);
  });

  it("reads an excerpt whose recorded bound is above today's maximum", () => {
    const older = excerptRejectedReply(reply, CEILING * 2, offset);
    expect(older.bound).toBeGreaterThan(CEILING);
    expect(isRejectedReplyExcerptOf(older, shape)).toBe(true);
  });

  it("keeps a stored segment the screen now matches readable, and withholds it on display", () => {
    // Written before a scanner rule existed for it: the record stays readable.
    const stored: InferenceRejectedReplyExcerptV1 = {
      ...excerpt,
      segments: [
        { ...excerpt.segments[0]!, text: `Use AIza${"Sy0123456789abcdefghijklmnopqrstuvw"} now.` },
        ...excerpt.segments.slice(1),
      ],
    };
    expect(isRejectedReplyExcerptOf(stored, shape)).toBe(true);
    const projected = projectRejectedReplyExcerpt(stored, hostRootSet([]));
    expect(projected.segments[0]).toMatchObject({ text: "", withheld: "credential-material" });
    expect(projected.segments[1]!.text).toBe(excerpt.segments[1]!.text);
  });

  it("shows no excerpt for an attempt whose excerpt does not match its fingerprint", () => {
    const record = (rejectedReplyExcerpt: unknown) =>
      ({
        steps: [
          {
            id: "verify-technical-accuracy",
            status: "failed",
            inference: {
              attempts: [
                {
                  attempt: 1,
                  outcome: "malformed-response",
                  retryable: false,
                  retryScheduled: false,
                  durationMs: 1,
                  rejectedReplyShape: shape,
                  rejectedReplyExcerpt,
                },
              ],
            },
          },
        ],
      }) as unknown as RunRecord;
    expect(readRunRetryDispositions(record(excerpt))[0]?.rejectedReplyExcerpt).toBeDefined();
    const mismatched = record({ ...excerpt, replyChars: excerpt.replyChars + 1 });
    expect(readRunRetryDispositions(mismatched)[0]?.rejectedReplyExcerpt).toBeUndefined();
    expect(formatRunRetryDispositionLines(mismatched).join("\n")).not.toContain("Reply excerpt");
  });

  it("escapes invisible characters in the delivery CLI JSON envelope too", () => {
    const json = serializeRunResultCliJson(
      { schemaVersion: 1, note: "a\u202eb\u2028c\u009b" } as unknown as RunResultV1,
      { workUnitMachineContracts: { label: "d\u202ce" } } as unknown as RunRecord,
    );
    for (const character of ["\u202e", "\u2028", "\u009b", "\u202c"]) {
      expect(json).not.toContain(character);
    }
    const parsed = JSON.parse(json) as {
      note: string;
      workUnitMachineContracts: { label: string };
    };
    expect(parsed.note).toBe("a\u202eb\u2028c\u009b");
    expect(parsed.workUnitMachineContracts.label).toBe("d\u202ce");
  });

  it("escapes terminal control, format, and line-separator characters in segment text", () => {
    const hostile = "a\u001b[31mred\u009b\u202eevil\u2028next\u{e0041}";
    const lines = formatRejectedReplyExcerptLines(excerptRejectedReply(hostile, BOUND));
    expect(lines[1]).toBe(
      String.raw`  head 0-22: "a\u001b[31mred\u009b\u202eevil\u2028next\u{e0041}"`,
    );
    expect(lines.join("\n")).not.toMatch(/[\u001b\u009b\u202e\u2028]/u);
  });

  it("flags the excerpt on the attempt's index row without copying its text", () => {
    const attempt = (extra: Record<string, unknown>) => ({
      attempt: 1,
      outcome: "malformed-response",
      retryable: true,
      durationMs: 1,
      rejectedReplyShape: shape,
      ...extra,
    });
    const withheldReply = `Use AIza${"Sy0123456789abcdefghijklmnopqrstuvw"} now.`;
    const withheldShape = fingerprintRejectedReply(withheldReply, () => true);
    const withheld = excerptRejectedReply(withheldReply, BOUND, 0);
    const record = {
      schemaVersion: 2,
      id: "excerpt-index",
      workflow: "review-documentation",
      status: "failed",
      createdAt: "2026-09-30T12:00:00.000Z",
      repository: { sourcePath: "/fixture", revision: "b".repeat(40) },
      steps: [
        {
          id: "verify-technical-accuracy",
          status: "failed",
          inference: {
            attempts: [
              attempt({ rejectedReplyExcerpt: excerpt }),
              attempt({ rejectedReplyExcerpt: excerptRejectedReply(reply, 0, offset) }),
              attempt({ rejectedReplyShape: withheldShape, rejectedReplyExcerpt: withheld }),
              attempt({}),
              attempt({ rejectedReplyExcerpt: { ...excerpt, extra: "reply prose" } }),
            ],
          },
        },
      ],
    };
    const projection = projectRunIndexRows(record, {
      origin: "import",
      snapshotId: "snapshot-1",
      indexedAt: "2026-09-30T12:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error(projection.reason);
    const rows = projection.rows.filter((row: RunIndexRowV1) => row.rowKind === "attempt");
    expect(rows.map((row) => row.rejectedReplyExcerpt)).toEqual([
      "retained",
      "empty",
      "withheld",
      null,
      null,
    ]);
    expect(rows[4]!.omittedFields).toEqual(["rejectedReplyExcerpt"]);
    expect(JSON.stringify(projection.rows)).not.toContain("reasoning");
    expect(JSON.stringify(projection.rows)).not.toContain("reply prose");
  });
});

describe("rejected reply excerpt bound resolves through limit() (#1690)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attaches the excerpt with the fingerprint under the host override, and refuses one out of range", () => {
    vi.stubEnv("DOCSFAB_INFERENCE_REJECTED_REPLY_EXCERPT_CHARS", "64");
    const rejected = new InferenceStepError("rejected", "malformed-response", true);
    const reply = `Thinking first. ${filler(300)}`;
    retainRejectedReplyShape(rejected, reply, resolveRejectedReplyShapePolicy());
    expect(rejected.rejectedReplyExcerpt).toMatchObject({
      bound: 64,
      parseOffset: 0,
      omittedChars: reply.length - 128,
    });
    expect(
      isRejectedReplyExcerptOf(rejected.rejectedReplyExcerpt, rejected.rejectedReplyShape),
    ).toBe(true);

    const provider = new InferenceStepError("down", "provider-transient", true);
    retainRejectedReplyShape(provider, reply, resolveRejectedReplyShapePolicy());
    expect(provider.rejectedReplyExcerpt).toBeUndefined();

    vi.stubEnv("DOCSFAB_INFERENCE_REJECTED_REPLY_EXCERPT_CHARS", String(CEILING + 1));
    expect(() => resolveRejectedReplyShapePolicy()).toThrow(
      `DOCSFAB_INFERENCE_REJECTED_REPLY_EXCERPT_CHARS must be an integer from 0 through ${CEILING}.`,
    );
  });
});

describe("rejected reply excerpt text is well-formed UTF-16 (#1690)", () => {
  const LENGTH = 4000;
  const STOP = 2000;
  const HALF = Math.floor(BOUND / 2);
  const HIGH = "\uD83D";
  const LOW = "\uDE00";
  const LONE = 3900;
  // Snapped edges: the head ends before a pair, the window starts after one,
  // and the window then ends and the tail starts at pairs placed on those cuts.
  const WINDOW_START = STOP - HALF + 1;
  const WINDOW_END = WINDOW_START + BOUND - 1;
  const TAIL_START = LENGTH - BOUND + 1;
  const INVISIBLE = ["\u009b", "\u202e", "\u202c", "\u2028"];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  /**
   * An array holding one string whose strict parse stops at `STOP`, with an
   * astral character across each segment cut, invisible characters in the
   * head, and an unpaired surrogate the reply already carried after the stop.
   */
  function astralReply(): string {
    const units = Array.from({ length: LENGTH }, () => "a");
    units[0] = "[";
    units[1] = '"';
    INVISIBLE.forEach((character, index) => {
      units[20 + index] = character;
    });
    units[STOP - 2] = '"';
    units[STOP - 1] = ",";
    units[STOP] = "x";
    units[LENGTH - 1] = "]";
    for (const cut of [BOUND, STOP - HALF, WINDOW_START + BOUND, LENGTH - BOUND]) {
      units[cut - 1] = HIGH;
      units[cut] = LOW;
    }
    units[LONE] = HIGH;
    return units.join("");
  }

  it("never cuts inside a surrogate pair and replaces an unpaired half", () => {
    const reply = astralReply();
    const shape = fingerprintRejectedReply(reply, () => true);
    expect(shape.parse).toMatchObject({ status: "failed", offset: STOP });
    const excerpt = excerptRejectedReply(reply, BOUND, STOP);
    expect(excerpt.segments.map(({ role, start, end }) => [role, start, end])).toEqual([
      ["head", 0, BOUND - 1],
      ["parse-position", WINDOW_START, WINDOW_END],
      ["tail", TAIL_START, LENGTH],
    ]);
    for (const segment of excerpt.segments) {
      expect(segment.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    }
    expect(excerpt.segments[2]!.text).toContain("\uFFFD");
    expect(isRejectedReplyExcerptOf(excerpt, shape)).toBe(true);
  });

  it("keeps the run record readable through runs show, with invisible characters escaped in --json", async () => {
    const reply = astralReply();
    const shape = fingerprintRejectedReply(reply, () => true);
    const excerpt = excerptRejectedReply(reply, BOUND, STOP);
    const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-excerpt-utf16-"));
    temporary.push(stateDirectory);
    const record = {
      schemaVersion: 2,
      id: "excerpt-utf16",
      workflow: "review-documentation",
      repository: {
        sourcePath: stateDirectory,
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
      },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      createdAt: "2026-09-30T12:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      error: "Technical review response rejected: invalid-json.",
      steps: [
        {
          id: "verify-technical-accuracy",
          title: "Technical verification",
          skill: "verify-technical-accuracy",
          mode: "read-only",
          status: "failed",
          error: "Technical review response rejected: invalid-json.",
          inference: {
            configuredMaxRetries: 0,
            effectiveMaxRetries: 0,
            baseDelayMs: 0,
            maxDelayMs: 0,
            retryableCategories: [],
            replay: "read-only",
            attempts: [
              {
                attempt: 1,
                outcome: "malformed-response",
                retryable: false,
                retryScheduled: false,
                durationMs: 1,
                rejectedReplyShape: shape,
                rejectedReplyExcerpt: excerpt,
              },
            ],
          },
        },
      ],
    };
    const serialized = JSON.stringify(record);
    expect(() => parseJsonEvidence(serialized)).not.toThrow();
    await writeFile(join(stateDirectory, `${record.id}.json`), serialized, { mode: 0o600 });
    const show = async (json: boolean): Promise<string> => {
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((value) => {
        lines.push(String(value));
      });
      try {
        await handleRunsCommand([
          "show",
          record.id,
          "--state-dir",
          stateDirectory,
          ...(json ? ["--json"] : []),
        ]);
      } finally {
        log.mockRestore();
      }
      return lines.join("\n");
    };

    const text = await show(false);
    for (const range of [
      `head 0-${BOUND - 1}: `,
      `parse-position ${WINDOW_START}-${WINDOW_END}: `,
      `tail ${TAIL_START}-${LENGTH}: `,
    ]) {
      expect(text).toContain(range);
    }
    const json = await show(true);
    for (const character of INVISIBLE) expect(json).not.toContain(character);
    const segments = (
      JSON.parse(json) as {
        retryDispositions: Array<{ rejectedReplyExcerpt: { segments: Array<{ text: string }> } }>;
      }
    ).retryDispositions[0]!.rejectedReplyExcerpt.segments;
    expect(segments[0]!.text.slice(20, 24)).toBe(INVISIBLE.join(""));
  });
});
