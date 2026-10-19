// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Object members delivered as JSON strings (#1707, design v9 §10). Some
 * serving stacks forward `evaluation` and `qualityScore` as JSON strings. The
 * host decodes such a string exactly once, with the same strict parser, and
 * admits only what the object form admits. Every fixture streams raw argument
 * text, never `JSON.stringify` chunks, so the escapes reach the host exactly
 * as written.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import { excerptRejectedReply } from "../src/execution/rejected-reply-excerpt.js";
import {
  QualityArtifactEnvelopeError,
  decodeQualityArtifactResponse,
  decodeQualitySubmission,
} from "../src/harness/quality-candidate-tool.js";
import { qualityResponseCorrection } from "../src/workflow-execution/quality-response-correction.js";
import { internalOnly } from "./helpers/internal-path.js";
import {
  type PiHarnessOptions,
  captureInferenceFailure,
  createRepository,
  resetSharedTestState,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";
import {
  FIXTURE_REPORT,
  SUBMIT,
  qualityStepInput,
  rawToolCallTurn,
  recordingProvider,
  submissionCall,
  toolPathHarness,
} from "./support/answer-submission-fixtures.js";

afterEach(async () => {
  vi.useRealTimers();
  await resetSharedTestState();
});

const SESSION = 60_000;
const raw = String.raw;

const SELECTION = { selectionSha256: "a".repeat(64) } as NonNullable<
  HarnessStepInput["qualityProfileSelection"]
>;

/** The object form, and the same members with `evaluation` sent as one JSON string. */
const OBJECT_FORM = raw`{"evaluation":{"evaluation_id":"eval-1","note":"a \"quoted\" {brace} and a \\ backslash"},"qualityScore":null}`;
const STRING_FORM = raw`{"evaluation":"{\"evaluation_id\":\"eval-1\",\"note\":\"a \\\"quoted\\\" {brace} and a \\\\ backslash\"}","qualityScore":null}`;
/** The decoded member string of {@link STRING_FORM}. */
const STRING_FORM_INNER = raw`{"evaluation_id":"eval-1","note":"a \"quoted\" {brace} and a \\ backslash"}`;

/**
 * The V1 arguments build.nvidia.com returned under the untyped shell in the
 * first qualification probe, every member a string (`null` too). Its SHA-256
 * is the observation's V1 `rawSha256`.
 */
const RETAINED_V1 = raw`{"evaluation":"{\"probe\": \"V1\", \"nested\": {\"level\": 2, \"items\": [\"a\", \"b\"]}}","qualityScore":"null"}`;
const OBSERVATION_PATH =
  "packages/runtime/docs/internal/evidence/answer-submission-probe-2026-10-02/observation.json";
const retainedObservation = internalOnly(
  OBSERVATION_PATH,
  "it reads the retained first-probe observation, which is not exported",
);

function refusalOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof QualityArtifactEnvelopeError) return error.rejection;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

/** Pi's own lenient argument parser, as the session runs it. */
async function piParseStreamingJson(): Promise<(text: string) => unknown> {
  for (const base of piRequire.resolve.paths("@earendil-works/pi-ai") ?? []) {
    const directory = join(base, "@earendil-works/pi-ai");
    if (existsSync(join(directory, "package.json"))) {
      const module = (await import(pathToFileURL(join(directory, "dist/index.js")).href)) as {
        parseStreamingJson: (text: string) => unknown;
      };
      return module.parseStreamingJson;
    }
  }
  throw new Error("Pi dependency @earendil-works/pi-ai is not installed.");
}

/** The settled assistant tool calls' arguments as Pi parsed them, per turn. */
function capturePiArguments() {
  const turns: Array<Array<{ name: string; arguments: unknown }>> = [];
  const configureSession: NonNullable<PiHarnessOptions["configureSession"]> = (session) => {
    session.subscribe((event) => {
      if (event.type !== "turn_end" || event.message.role !== "assistant") return;
      const content = (event.message as { content?: unknown[] }).content ?? [];
      turns.push(
        content
          .filter((block) => (block as { type?: string }).type === "toolCall")
          .map((block) => ({
            name: (block as { name: string }).name,
            arguments: (block as { arguments: unknown }).arguments,
          })),
      );
    });
  };
  return { turns, configureSession };
}

describe("the submission decoder on members sent as JSON strings", () => {
  it("T-S1: admits a stringified evaluation as exactly the object form's members", () => {
    const object = decodeQualitySubmission(OBJECT_FORM);
    const stringified = decodeQualitySubmission(STRING_FORM);

    expect(JSON.stringify(stringified.evaluation)).toBe(JSON.stringify(object.evaluation));
    expect(stringified.qualityScore).toBeNull();
    expect(object.memberEncoding).toEqual({ evaluation: "object", qualityScore: "null" });
    expect(stringified.memberEncoding).toEqual({ evaluation: "string", qualityScore: "null" });
    expect(object.innerBytes).toBe(0);
    expect(stringified.innerBytes).toBe(Buffer.byteLength(STRING_FORM_INNER, "utf8"));
    // Decoding never grows the content.
    expect(stringified.innerBytes).toBeLessThan(Buffer.byteLength(STRING_FORM, "utf8"));
  });

  it('T-S2: admits qualityScore "null" and a stringified score object, and nothing else as a string', () => {
    const nullScore = decodeQualitySubmission(raw`{"evaluation":{"a":1},"qualityScore":"null"}`);
    expect(nullScore.qualityScore).toBeNull();
    expect(nullScore.memberEncoding).toEqual({ evaluation: "object", qualityScore: "string" });
    expect(nullScore.innerBytes).toBe(4);

    const objectScore = decodeQualitySubmission(
      raw`{"evaluation":{"a":1},"qualityScore":"{\"score\":3}"}`,
    );
    expect(objectScore.qualityScore).toEqual({ score: 3 });
    expect(objectScore.memberEncoding.qualityScore).toBe("string");

    for (const [score, code] of [
      ["Null", "quality-submission-json"],
      ["nul", "quality-submission-json"],
      [" null x", "quality-submission-json"],
      [raw`\"null\"`, "quality-submission-shape"],
      ["0", "quality-submission-shape"],
      ["false", "quality-submission-shape"],
      ["[]", "quality-submission-shape"],
    ] as const) {
      expect(
        refusalOf(() =>
          decodeQualitySubmission(`{"evaluation":{"a":1},"qualityScore":"${score}"}`),
        ),
        score,
      ).toEqual({ code, location: "$.qualityScore" });
    }
  });

  it("T-S3: refuses a duplicate key inside the string, which Pi's parse and JSON.parse collapse", async () => {
    const submission = raw`{"evaluation":"{\"evaluation_id\":\"e\",\"evaluation_id\":\"f\"}","qualityScore":null}`;
    expect(refusalOf(() => decodeQualitySubmission(submission))).toEqual({
      code: "quality-submission-duplicate-key",
      location: "$.evaluation",
    });
    const inner = (JSON.parse(submission) as { evaluation: string }).evaluation;
    expect(JSON.parse(inner)).toEqual({ evaluation_id: "f" });
    const parseStreamingJson = await piParseStreamingJson();
    expect(parseStreamingJson(inner)).toEqual({ evaluation_id: "f" });
  });

  it.each([
    ["T-S4 trailing tokens", raw`{"evaluation":"{\"a\":1} x","qualityScore":null}`],
    ["T-S4 a second document", raw`{"evaluation":"{\"a\":1}{}","qualityScore":null}`],
    ["T-S5 cut text", raw`{"evaluation":"{\"a\":","qualityScore":null}`],
    ["T-S5 an empty string", raw`{"evaluation":"","qualityScore":null}`],
    ["T-S5 a comment", raw`{"evaluation":"{\"a\":1 /* note */}","qualityScore":null}`],
    [
      "T-S6 a raw line break inside an inner string literal",
      raw`{"evaluation":"{\"a\":\"line one\nline two\"}","qualityScore":null}`,
    ],
    [
      "T-S6 a raw tab inside an inner string literal",
      raw`{"evaluation":"{\"a\":\"x\ty\"}","qualityScore":null}`,
    ],
  ])("%s inside the string gets quality-submission-json at the member", (_name, submission) => {
    expect(refusalOf(() => decodeQualitySubmission(submission))).toEqual({
      code: "quality-submission-json",
      location: "$.evaluation",
    });
  });

  it("T-S6: admits line breaks between inner tokens, which are whitespace", () => {
    const members = decodeQualitySubmission(
      raw`{"evaluation":"{\n  \"a\": 1,\r\n\t\"b\": [2]\n}\n","qualityScore":null}`,
    );
    expect(members.evaluation).toEqual({ a: 1, b: [2] });
  });

  it("T-S7: refuses double encoding at the member, with the no-recursion hint", () => {
    expect(
      refusalOf(() =>
        decodeQualitySubmission(raw`{"evaluation":"\"{\\\"a\\\":1}\"","qualityScore":null}`),
      ),
    ).toEqual({ code: "quality-submission-shape", location: "$.evaluation" });
  });

  it.each([
    ["an array", raw`{"evaluation":"[1,2]","qualityScore":null}`],
    ["a number", raw`{"evaluation":"42","qualityScore":null}`],
    ["null", raw`{"evaluation":"null","qualityScore":null}`],
  ])("T-S8: refuses an evaluation string that decodes to %s", (_name, submission) => {
    expect(refusalOf(() => decodeQualitySubmission(submission))).toEqual({
      code: "quality-submission-shape",
      location: "$.evaluation",
    });
  });

  it("T-S9: never reads the root or a third member from a string", () => {
    expect(
      refusalOf(() => decodeQualitySubmission(raw`"{\"evaluation\":{},\"qualityScore\":null}"`)),
    ).toEqual({
      code: "quality-submission-shape",
      location: "$",
    });
    try {
      decodeQualitySubmission(
        raw`{"evaluation":"{}","qualityScore":null,"reportMarkdown":"\"# R\""}`,
      );
      throw new Error("Expected a refusal.");
    } catch (error) {
      expect((error as QualityArtifactEnvelopeError).rejection).toEqual({
        code: "quality-submission-shape",
        location: "$",
      });
      expect((error as QualityArtifactEnvelopeError).receivedKeys).toEqual([
        "evaluation",
        "qualityScore",
        "reportMarkdown",
      ]);
    }
  });

  it("T-S11: the text answer still refuses a string evaluation", () => {
    expect(
      refusalOf(() =>
        decodeQualityArtifactResponse(
          `${raw`{"evaluation":"{\"a\":1}","qualityScore":null}`}\n\n${FIXTURE_REPORT}`,
          SELECTION,
        ),
      ),
    ).toEqual({ code: "quality-envelope-shape", location: "$.evaluation" });
  });

  it("T-S14: admits the exact V1 arguments the qualification route returned", () => {
    const members = decodeQualitySubmission(RETAINED_V1);
    expect(members).toMatchObject({
      evaluation: { probe: "V1", nested: { level: 2, items: ["a", "b"] } },
      qualityScore: null,
      memberEncoding: { evaluation: "string", qualityScore: "string" },
    });
  });

  it.skipIf(retainedObservation.skip)(
    retainedObservation.title("T-S14: the V1 fixture is the observation's V1 bytes, by SHA-256"),
    () => {
      const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
      const observation = JSON.parse(
        readFileSync(join(repositoryRoot, OBSERVATION_PATH), "utf8"),
      ) as { samples: Array<{ variant: string; shell: string; rawSha256: string | null }> };
      const v1 = observation.samples.filter((sample) => sample.variant === "V1");
      expect(v1).toHaveLength(3);
      const digest = createHash("sha256").update(RETAINED_V1).digest("hex");
      for (const sample of v1)
        expect(sample).toMatchObject({ shell: "untyped", rawSha256: digest });
    },
  );
});

describe("PiHarness admission of members sent as JSON strings", () => {
  it(
    "T-S1: stores the same candidate as the object form, and records the string encoding",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", OBJECT_FORM, 5)]),
        textTurn(FIXTURE_REPORT),
      ]);
      const objectForm = await toolPathHarness().runStep(input);
      vi.unstubAllGlobals();

      recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", STRING_FORM, 7)]),
        textTurn(FIXTURE_REPORT),
      ]);
      const stringForm = await toolPathHarness().runStep(input);

      expect(JSON.stringify(stringForm.qualityArtifactCandidate)).toBe(
        JSON.stringify(objectForm.qualityArtifactCandidate),
      );
      expect(objectForm.answerSubmission).toMatchObject({
        submission: "admitted",
        memberEncoding: { evaluation: "object", qualityScore: "null" },
      });
      expect(objectForm.answerSubmission).not.toHaveProperty("submissionInnerBytes");
      expect(stringForm.answerSubmission).toEqual({
        path: "tool-call",
        reason: "recorded-route",
        submission: "admitted",
        reportTurn: "admitted",
        memberEncoding: { evaluation: "string", qualityScore: "null" },
        submissionInnerBytes: Buffer.byteLength(STRING_FORM_INNER, "utf8"),
      });
    },
    SESSION,
  );

  it(
    "T-S14: admits the retained V1 arguments streamed in chunks, every member a string",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", RETAINED_V1, 9)]),
        textTurn(FIXTURE_REPORT),
      ]);

      const result = await toolPathHarness().runStep(input);

      expect(result.qualityArtifactCandidate).toMatchObject({
        evaluation: { probe: "V1", nested: { level: 2, items: ["a", "b"] } },
        qualityScore: null,
      });
      expect(result.answerSubmission).toMatchObject({
        submission: "admitted",
        memberEncoding: { evaluation: "string", qualityScore: "string" },
      });
    },
    SESSION,
  );

  it(
    "T-S3: refuses a stringified member written twice, which Pi's parse collapses to the last",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([
          submissionCall(
            "submit-1",
            raw`{"evaluation":"{\"a\":1}","evaluation":"{\"a\":2}","qualityScore":null}`,
          ),
        ]),
      ]);
      const pi = capturePiArguments();

      const error = await captureInferenceFailure(
        toolPathHarness({ configureSession: pi.configureSession }),
        input,
      );

      expect(error.rejection).toMatchObject({ code: "quality-submission-duplicate-key" });
      expect(pi.turns[0]?.[0]?.arguments).toEqual({ evaluation: raw`{"a":2}`, qualityScore: null });
    },
    SESSION,
  );

  it(
    "T-S3: refuses a duplicate key inside the string split across chunk boundaries, which Pi's parse let through",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([
          {
            id: "submit-1",
            name: SUBMIT,
            chunks: [
              raw`{"evaluation":"{\"evaluation_id\":\"e\",\"evaluation_`,
              raw`id\":\"f\"}","qualityScore":null}`,
            ],
          },
        ]),
      ]);
      const pi = capturePiArguments();

      const error = await captureInferenceFailure(
        toolPathHarness({ configureSession: pi.configureSession }),
        input,
      );

      expect(error.rejection).toEqual({
        code: "quality-submission-duplicate-key",
        location: "$.evaluation",
      });
      expect(error.evidence?.answerSubmission).toMatchObject({ submission: "refused" });
      const parsed = pi.turns[0]?.[0]?.arguments as { evaluation: string };
      expect(typeof parsed.evaluation).toBe("string");
      expect(JSON.parse(parsed.evaluation)).toEqual({ evaluation_id: "f" });
    },
    SESSION,
  );

  it(
    "T-S9: names the received keys in the retry repair for a stringified third member",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([
        rawToolCallTurn([
          submissionCall(
            "submit-1",
            raw`{"evaluation":"{}","qualityScore":"null","reportMarkdown":"\"# R\""}`,
          ),
        ]),
      ]);

      const error = await captureInferenceFailure(toolPathHarness(), input);

      expect(error.rejection).toEqual({ code: "quality-submission-shape", location: "$" });
      expect(qualityResponseCorrection(error)).toMatchObject({
        kind: "quality-key-set",
        undeclared: ["reportMarkdown"],
      });
    },
    SESSION,
  );

  // A credential written with one JSON escape in the outer text: the raw
  // screens read `glpat` and an escaped hyphen; the decoded member string
  // reads `glpat-…`.
  const HIDDEN = `glpat\\u002d${"x".repeat(24)}`;

  it(
    "T-S10: withholds the excerpt of a refused submission whose decoded string holds a credential",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      const refused = (note: string) =>
        raw`{"evaluation":"{\"note\":\"${note}\"} trailing","qualityScore":null}`;

      recordingProvider([rawToolCallTurn([submissionCall("submit-1", refused(HIDDEN))])]);
      const hidden = await captureInferenceFailure(toolPathHarness({ composition: false }), input);
      vi.unstubAllGlobals();
      recordingProvider([rawToolCallTurn([submissionCall("submit-1", refused("plain note"))])]);
      const plain = await captureInferenceFailure(toolPathHarness({ composition: false }), input);

      for (const error of [hidden, plain]) {
        expect(error.rejection).toEqual({
          code: "quality-submission-json",
          location: "$.evaluation",
        });
      }
      // The control: the same refusal without the credential keeps its excerpt.
      expect(plain.rejectedReplyExcerpt?.segments.length).toBeGreaterThan(0);
      expect(plain.rejectedReplyExcerpt?.segments.every((segment) => !segment.withheld)).toBe(true);
      // The raw text alone does not show the credential to the screen…
      const outerOnly = excerptRejectedReply(refused(HIDDEN), 4_096);
      expect(outerOnly.segments.every((segment) => !segment.withheld)).toBe(true);
      // …but its decoded member string does, so every segment is withheld.
      expect(hidden.rejectedReplyExcerpt?.segments.length).toBeGreaterThan(0);
      for (const segment of hidden.rejectedReplyExcerpt?.segments ?? []) {
        expect(segment).toMatchObject({ text: "", withheld: "credential-material" });
      }
    },
    SESSION,
  );

  it(
    "T-S10: screens a stringified qualityScore too, after a stringified evaluation",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      // Both members are strings; the credential hides in the second one.
      const refused = (note: string) =>
        raw`{"evaluation":"{\"a\":1}","qualityScore":"{\"note\":\"${note}\"} trailing"}`;

      recordingProvider([rawToolCallTurn([submissionCall("submit-1", refused(HIDDEN))])]);
      const hidden = await captureInferenceFailure(toolPathHarness({ composition: false }), input);
      vi.unstubAllGlobals();
      recordingProvider([rawToolCallTurn([submissionCall("submit-1", refused("plain note"))])]);
      const plain = await captureInferenceFailure(toolPathHarness({ composition: false }), input);

      for (const error of [hidden, plain]) {
        expect(error.rejection).toEqual({
          code: "quality-submission-json",
          location: "$.qualityScore",
        });
      }
      expect(plain.rejectedReplyExcerpt?.segments.every((segment) => !segment.withheld)).toBe(true);
      expect(
        excerptRejectedReply(refused(HIDDEN), 4_096).segments.every((segment) => !segment.withheld),
      ).toBe(true);
      expect(hidden.rejectedReplyExcerpt?.segments.length).toBeGreaterThan(0);
      for (const segment of hidden.rejectedReplyExcerpt?.segments ?? []) {
        expect(segment).toMatchObject({ text: "", withheld: "credential-material" });
      }
    },
    SESSION,
  );

  it(
    "T-S10: bounds the raw outer bytes, escapes included, not the decoded string",
    async () => {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      // Each `\\\"` is four outer bytes and two in the decoded member string.
      const quotes = raw`\\\"`.repeat(150);
      const submission = raw`{"evaluation":"{\"note\":\"${quotes}\"}","qualityScore":null}`;
      const inner = (JSON.parse(submission) as { evaluation: string }).evaluation;
      const outerBytes = Buffer.byteLength(submission, "utf8");
      const innerBytes = Buffer.byteLength(inner, "utf8");
      const limit = 2_048;
      // The report fits beside the decoded string, but not beside the raw text.
      // Each provider response stays under the bound on its own.
      const report = `# Report\n\n${"y".repeat(limit - Math.floor((outerBytes + innerBytes) / 2) - 10)}`;
      const reportBytes = Buffer.byteLength(report, "utf8");
      expect(innerBytes + reportBytes).toBeLessThan(limit);
      expect(outerBytes + reportBytes).toBeGreaterThan(limit);
      recordingProvider([
        rawToolCallTurn([submissionCall("submit-1", submission, 1)]),
        textTurn(report),
      ]);

      const error = await captureInferenceFailure(
        toolPathHarness({ maxResponseBytes: limit }),
        input,
      );

      expect(error.message).toContain("exceeded the composition response byte limit");
      expect(error.message).toContain(`limit=${String(limit)}`);
      expect(error.evidence?.answerSubmission).toMatchObject({
        submission: "admitted",
        reportTurn: "refused",
      });
    },
    SESSION,
  );
});
