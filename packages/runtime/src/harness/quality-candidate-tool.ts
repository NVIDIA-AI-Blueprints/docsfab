// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type {
  HarnessStepInput,
  HarnessStepResult,
  QualityAnswerRecordCapabilityV1,
} from "../execution/contracts.js";
import {
  carryAdmittedTechnicalLocators,
  inspectTechnicalFactTrace,
  preflightQualityArtifactCandidateContent,
  type TechnicalFactTraceInspection,
} from "../evaluation-report/quality-artifact-staging.js";
import {
  OUTPUT_RECORD_CONTRACTS,
  OUTPUT_HOST_TEXT,
  rejectOutput,
  type OutputRuleRejection,
  type RuleCodeOf,
} from "../contracts/model-output.generated.js";
import { isAmbiguousJsonEnvelope, jsonEnvelopeBody } from "../execution/json-envelope.js";
import { isJsonEvidence, JsonEvidenceError, parseJsonEvidence } from "../json-evidence.js";
import type { VerificationResult } from "../workflow-execution/verification-result.js";
import { QUALITY_CANDIDATE_VALIDATION_TOOL_NAME } from "./pi-tool-confine.js";
import { answerRecordReceiptForWire } from "./answer-records.js";
import {
  buildSubmissionShell,
  QUALITY_SUBMISSION_TOOL_NAME,
  QUALITY_ANSWER_RECORD_TOOL_NAME,
  type SubmissionMemberType,
} from "./answer-submission.js";
import {
  QUALITY_ARTIFACT_ANSWER_KEYS,
  QUALITY_ARTIFACT_RESPONSE_KEYS,
} from "../execution/response-contract-keys.js";
// Key sets live in one dependency-free module.
export { QUALITY_ARTIFACT_RESPONSE_KEYS } from "../execution/response-contract-keys.js";

export const QUALITY_CANDIDATE_JSON_MAX_BYTES = 4 * 1024 * 1024;

/** Test-injected only; absence of the process-local capability keeps this route off. */
export function createQualityAnswerRecordTool(
  capability: QualityAnswerRecordCapabilityV1,
  guidance?: string,
): ToolDefinition<any, any, any> {
  return {
    name: QUALITY_ANSWER_RECORD_TOOL_NAME,
    label: "Submit quality answer record",
    description:
      "Submit one declared quality-evaluation record. The host checks and admits the captured call.",
    promptSnippet: [
      "Submit one quality evaluation record per call; multiple calls per turn are supported. Read each host receipt and correct any named record before finalizing.",
      ...(guidance ? ["Host-resolved answer-record plan:", guidance] : []),
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: OUTPUT_RECORD_CONTRACTS["quality-evaluation"].records.map((record) => record.type),
        },
        key: { type: ["string", "null"] },
        // Intentionally optional: Pi may normalize record:null away. The host
        // always admits the captured raw bytes bound to toolCallId instead.
        record: { type: ["object", "string"] },
      },
    },
    async execute(toolCallId: string) {
      const receipt = answerRecordReceiptForWire(
        capability.receipt(toolCallId),
        OUTPUT_RECORD_CONTRACTS["quality-evaluation"],
      );
      const text = JSON.stringify(receipt);
      return {
        ...(receipt.status === "refused" ? { isError: true } : {}),
        content: [{ type: "text", text }],
        details: { kind: "docsfab-answer-record-receipt" },
      };
    },
  };
}

type QualityEnvelopeRejectionCode = RuleCodeOf<"quality-envelope">;

/** The codes of the answer submitted through the tool call. */
export type QualitySubmissionRejectionCode = RuleCodeOf<"quality-submission">;

type EnvelopeMember = "$.evaluation" | "$.qualityScore" | "$.reportMarkdown";

/**
 * A refused quality artifact answer, with the catalog rule it broke and where:
 * the text answer's envelope, or the tool-call submission and its report.
 */
export class QualityArtifactEnvelopeError extends Error {
  public constructor(
    public readonly rejection: OutputRuleRejection<
      QualityEnvelopeRejectionCode | QualitySubmissionRejectionCode
    >,
    /** The refused object's top-level keys, for a shape refusal of a parsed object. */
    public readonly receivedKeys?: readonly string[],
  ) {
    super("The final evaluator returned an invalid quality artifact envelope.");
    this.name = "QualityArtifactEnvelopeError";
  }
}

function refuse(
  rejection: OutputRuleRejection<QualityEnvelopeRejectionCode | QualitySubmissionRejectionCode>,
  receivedKeys?: readonly string[],
): never {
  throw new QualityArtifactEnvelopeError(rejection, receivedKeys);
}

/**
 * Read the final quality evaluator's answer into the quality artifact
 * candidate. The candidate-validation tool decodes its draft through this same
 * function, so it predicts exactly what the final admission reads.
 *
 * The contract asks for the answer form: one strict JSON object holding
 * `evaluation` and `qualityScore`, then the report as Markdown after it, which
 * the host stores as `reportMarkdown`. The three-member JSON envelope is still
 * read exactly as before, so a host-completed cut and a model that returns the
 * envelope are admitted as before. A reply both forms could read is refused
 * rather than guessed. Both forms reach the same member checks and the same
 * downstream validation.
 */
export function decodeQualityArtifactResponse(
  response: string,
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>,
): NonNullable<HarnessStepResult["qualityArtifactCandidate"]> {
  const answer = readAnswerForm(response);
  if (answer.form === "answer") {
    return admitMembers(answer.evaluation, answer.qualityScore, answer.report, selection);
  }
  if (answer.form === "bad-head") {
    // A leading object that is broken or has other keys is no answer, so the
    // envelope reading, the only one left, admits what it always admitted;
    // otherwise the object's own defect is the rule the reply broke.
    try {
      return readEnvelopeForm(response, selection);
    } catch (error) {
      if (!(error instanceof QualityArtifactEnvelopeError)) throw error;
      refuse(answer.rejection, answer.receivedKeys);
    }
  }
  return readEnvelopeForm(response, selection);
}

function readEnvelopeForm(
  response: string,
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>,
): NonNullable<HarnessStepResult["qualityArtifactCandidate"]> {
  // The one shared model-reply extraction policy reads the envelope form.
  const body = jsonEnvelopeBody(response);
  try {
    return readEnvelope(response, body, selection);
  } catch (error) {
    // A reply that opens as an object but is not strict JSON can still hold one
    // fenced block, such as a JSON summary inside reportMarkdown, which the
    // shared policy then reads. The admission decision stays the policy's; the
    // rule the reply broke is its own syntax, so the refusal names that.
    const trimmed = response.trim();
    if (
      error instanceof QualityArtifactEnvelopeError &&
      body !== trimmed &&
      trimmed.startsWith("{")
    ) {
      try {
        parseJsonEvidence(trimmed);
      } catch (replyError) {
        refuse(jsonBreak(trimmed, replyError));
      }
    }
    throw error;
  }
}

function readEnvelope(
  response: string,
  body: string,
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>,
): NonNullable<HarnessStepResult["qualityArtifactCandidate"]> {
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(body);
  } catch (error) {
    // Several fenced JSON documents: the answer does not open with its bare
    // object. The shared "return only the JSON object" rule would contradict
    // the report the answer form writes after it, so the answer's own rule
    // is stated.
    if (isAmbiguousJsonEnvelope(response)) refuse(rejectOutput("quality-envelope-shape", "$"));
    refuse(jsonBreak(body, error));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse(rejectOutput("quality-envelope-shape", "$"));
  }
  const root = parsed as Record<string, unknown>;
  if (!hasExactly(root, QUALITY_ARTIFACT_RESPONSE_KEYS)) {
    refuse(rejectOutput("quality-envelope-shape", "$"), Object.keys(root));
  }
  return admitMembers(root.evaluation, root.qualityScore, root.reportMarkdown, selection);
}

type AnswerRead =
  | { readonly form: "none" }
  | {
      readonly form: "bad-head";
      readonly rejection: OutputRuleRejection<QualityEnvelopeRejectionCode>;
      readonly receivedKeys?: readonly string[];
    }
  | {
      readonly form: "answer";
      readonly evaluation: unknown;
      readonly qualityScore: unknown;
      readonly report: string;
    };

/**
 * The answer form. `none` when the reply is not in it: it does not open with a
 * closed object, the object is the whole reply and is not strict JSON, or the
 * object holds the three envelope members; the envelope reading decides those.
 * `bad-head` when a leading object with text after it is not strict JSON,
 * located at the member it broke in, because the text after it is not part of
 * any JSON document; or when the object is strict JSON with other keys, a
 * shape refusal at `$`. Once the object holds exactly the two answer members,
 * the text after it must be a report; anything else is refused here.
 */
function readAnswerForm(response: string): AnswerRead {
  const trimmed = response.trim();
  const end = leadingObjectEnd(trimmed);
  if (end === undefined) return { form: "none" };
  const head = trimmed.slice(0, end);
  const report = trimmed.slice(end).trim();
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(head);
  } catch (error) {
    // A whole-reply object is the envelope form, which codes its own break.
    return report ? { form: "bad-head", rejection: jsonBreak(head, error) } : { form: "none" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { form: "none" };
  const root = parsed as Record<string, unknown>;
  if (!hasExactly(root, QUALITY_ARTIFACT_ANSWER_KEYS)) {
    return hasExactly(root, QUALITY_ARTIFACT_RESPONSE_KEYS)
      ? { form: "none" }
      : {
          form: "bad-head",
          rejection: rejectOutput("quality-envelope-shape", "$"),
          receivedKeys: Object.keys(root),
        };
  }
  return {
    form: "answer",
    evaluation: root.evaluation,
    qualityScore: root.qualityScore,
    report: admitReport(response, report, TEXT_ANSWER_REPORT_CODES),
  };
}

/** JSON that goes on after the answer's object: a separator, a close, a string, or another object. */
const JSON_CONTINUATION = /^[,:{}\]"]/u;

/** An ATX heading line, the way the report template opens. */
const REPORT_OPENING_HEADING = /^#{1,6}[ \t]+\S/u;

/** A JSON member naming one of the answer's members, anywhere on a line. */
const ANSWER_MEMBER = new RegExp(`"(?:${QUALITY_ARTIFACT_RESPONSE_KEYS.join("|")})"\\s*:`, "u");

/**
 * A JSON object opening on one of the answer's members: the head of a
 * restarted answer. Inline code never exempts it, because a report cut inside
 * an inline span leaves a backtick that pairs with one in the restarted head.
 */
const ANSWER_OBJECT_OPENING = new RegExp(
  `\\{\\s*"(?:${QUALITY_ARTIFACT_RESPONSE_KEYS.join("|")})"\\s*:`,
  "u",
);

/**
 * An inline code span on one line: a backtick run, then the nearest run of the
 * same length (CommonMark). A span that crosses a line break is not matched, so
 * its text stays checked.
 */
const INLINE_CODE_SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/gu;

/**
 * The codes each report rule raises on one answer path. The text answer's
 * report follows its JSON object in the same reply, so more JSON right after
 * the object has its own code; the submitted answer's report is a reply of
 * its own, so that case is refused by the heading-first rule instead.
 */
interface ReportCodes {
  readonly jsonAfterObject?: "quality-envelope-json-after-object";
  readonly report: "quality-envelope-report" | "quality-submission-report";
  readonly fence: "quality-envelope-report-fence" | "quality-submission-report-fence";
  readonly member: "quality-envelope-report-member" | "quality-submission-report-member";
  readonly envelope: "quality-envelope-report-envelope" | "quality-submission-report-envelope";
}

const TEXT_ANSWER_REPORT_CODES: ReportCodes = Object.freeze({
  jsonAfterObject: "quality-envelope-json-after-object",
  report: "quality-envelope-report",
  fence: "quality-envelope-report-fence",
  member: "quality-envelope-report-member",
  envelope: "quality-envelope-report-envelope",
});

const SUBMITTED_ANSWER_REPORT_CODES: ReportCodes = Object.freeze({
  report: "quality-submission-report",
  fence: "quality-submission-report-fence",
  member: "quality-submission-report-member",
  envelope: "quality-submission-report-envelope",
});

/**
 * The report a reply holds, or a refusal: it must open with a heading line
 * rather than more JSON or nothing, keep its code fences unambiguous, carry no
 * answer member outside fenced or inline code and no object opening on one
 * outside fenced code, and hold no whole envelope that the envelope reading of
 * `envelopeSource` would admit instead. On the text answer `envelopeSource` is
 * the whole reply; on the submitted answer it is the report reply itself.
 * Each condition is a way a malformed envelope, or an answer restarted after a
 * length-stop continuation, would otherwise land JSON in the stored report, so
 * each has its own rule and retry hint. A lone fence line that ends the report
 * hides nothing and is dropped, so the stored report stays well-formed.
 */
function admitReport(envelopeSource: string, report: string, codes: ReportCodes): string {
  if (codes.jsonAfterObject && JSON_CONTINUATION.test(report)) {
    refuse(rejectOutput(codes.jsonAfterObject, "$"));
  }
  if (!REPORT_OPENING_HEADING.test(report)) {
    refuse(rejectOutput(codes.report, "$.reportMarkdown"));
  }
  const markdown = outsideCodeFences(report);
  if (markdown.ambiguousFence) {
    refuse(rejectOutput(codes.fence, "$.reportMarkdown"));
  }
  if (
    markdown.lines.some(
      (line) =>
        ANSWER_OBJECT_OPENING.test(line) ||
        ANSWER_MEMBER.test(line.replaceAll(INLINE_CODE_SPAN, "")),
    )
  ) {
    refuse(rejectOutput(codes.member, "$.reportMarkdown"));
  }
  if (envelopeReadingHoldsEnvelope(envelopeSource)) {
    refuse(rejectOutput(codes.envelope, "$.reportMarkdown"));
  }
  return markdown.strayFenceAt === undefined
    ? report
    : report.slice(0, markdown.strayFenceAt).trimEnd();
}

/** A code fence line: three or more backticks or tildes, then the rest of the line. */
const CODE_FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/u;

/**
 * The lines outside fenced code blocks, and whether the fences are ambiguous.
 * A fence closes on a line of its own character, at least as long, with
 * nothing after it; a backtick run with a backtick after it is inline code,
 * not a fence (CommonMark). A fence left open with report text after it, or a
 * line inside a fence that would open another fence of the same kind, is
 * ambiguous: that is how a report cut inside a fence and then restarted hides
 * the restart. A bare fence line with only blank lines after it opens nothing
 * and hides nothing; `strayFenceAt` is the offset of that line.
 */
/** Admit the Markdown-only narrative paired with a completed records ledger. */
export function admitQualityAnswerRecordReport(report: string): string {
  return admitReport(report, report, SUBMITTED_ANSWER_REPORT_CODES);
}

function outsideCodeFences(markdown: string): {
  lines: string[];
  ambiguousFence: boolean;
  strayFenceAt?: number;
} {
  const lines: string[] = [];
  let open: { readonly run: string; readonly bare: boolean; readonly at: number } | undefined;
  let blankSinceOpen = true;
  let offset = 0;
  for (const raw of markdown.split("\n")) {
    // A CRLF line is read without its CR; the offset counts the raw line.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fence = CODE_FENCE.exec(line);
    const run = fence?.[1];
    const rest = fence?.[2] ?? "";
    if (open === undefined) {
      if (run !== undefined && !(run.startsWith("`") && rest.includes("`"))) {
        open = { run, bare: !rest.trim(), at: offset };
        blankSinceOpen = true;
      } else lines.push(line);
    } else if (run !== undefined && run[0] === open.run[0] && run.length >= open.run.length) {
      if (rest.trim()) return { lines, ambiguousFence: true };
      open = undefined;
    } else if (line.trim()) {
      blankSinceOpen = false;
    }
    offset += raw.length + 1;
  }
  if (open === undefined) return { lines, ambiguousFence: false };
  return open.bare && blankSinceOpen
    ? { lines, ambiguousFence: false, strayFenceAt: open.at }
    : { lines, ambiguousFence: true };
}

/** Whether the shared extraction policy would read a whole three-member envelope from the reply. */
function envelopeReadingHoldsEnvelope(response: string): boolean {
  const body = jsonEnvelopeBody(response);
  if (!isJsonEvidence(body)) return false;
  const parsed = parseJsonEvidence(body);
  return (
    !!parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    hasExactly(parsed as Record<string, unknown>, QUALITY_ARTIFACT_RESPONSE_KEYS)
  );
}

/**
 * The index just past the object the text opens with, found by lexing string
 * and bracket structure only; `undefined` when the text does not open with
 * `{` or the object never closes.
 */
function leadingObjectEnd(text: string): number | undefined {
  if (!text.startsWith("{")) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

function hasExactly(root: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(root).sort().join(",") === [...keys].sort().join(",");
}

/** The member checks both answer forms share, in member order. */
function admitMembers(
  evaluation: unknown,
  qualityScore: unknown,
  reportMarkdown: unknown,
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>,
): NonNullable<HarnessStepResult["qualityArtifactCandidate"]> {
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    refuse(rejectOutput("quality-envelope-shape", "$.evaluation"));
  }
  if (qualityScore !== null && (typeof qualityScore !== "object" || Array.isArray(qualityScore))) {
    refuse(rejectOutput("quality-envelope-shape", "$.qualityScore"));
  }
  if (
    typeof reportMarkdown !== "string" ||
    !reportMarkdown.trim() ||
    Buffer.byteLength(reportMarkdown, "utf8") > 2 * 1024 * 1024
  ) {
    refuse(rejectOutput("quality-envelope-shape", "$.reportMarkdown"));
  }
  return {
    evaluation: evaluation as Record<string, unknown>,
    qualityScore: qualityScore as Record<string, unknown> | null,
    reportMarkdown,
    selectionSha256: selection.selectionSha256,
  };
}

/**
 * The rule a strict-parser refusal broke, at the member it broke in. A
 * repeated key is its own rule, so the retry can say which key to write once.
 */
function jsonBreak(
  text: string,
  error: unknown,
): OutputRuleRejection<"quality-envelope-json" | "quality-envelope-duplicate-key"> {
  const location = jsonBreakMember(text, error, QUALITY_ARTIFACT_RESPONSE_KEYS) ?? "$";
  return error instanceof JsonEvidenceError && error.code === "duplicate-key"
    ? rejectOutput("quality-envelope-duplicate-key", location)
    : rejectOutput("quality-envelope-json", location);
}

/**
 * The same reading for the submitted arguments, whose members are the answer
 * keys only; a break inside any other top-level key is located at `$`.
 */
function submissionJsonBreak(
  text: string,
  error: unknown,
): OutputRuleRejection<"quality-submission-json" | "quality-submission-duplicate-key"> {
  const member = jsonBreakMember(text, error, QUALITY_ARTIFACT_ANSWER_KEYS);
  const location = member === "$.evaluation" || member === "$.qualityScore" ? member : "$";
  return error instanceof JsonEvidenceError && error.code === "duplicate-key"
    ? rejectOutput("quality-submission-duplicate-key", location)
    : rejectOutput("quality-submission-json", location);
}

/**
 * The envelope member whose value the strict parser was reading, or had just
 * finished, when it stopped. Lexes structure only, up to the parser's offset,
 * and compares each top-level key with the closed member set; no reply text is
 * kept. `undefined` when the parser gave no offset or stopped outside a member.
 */
function jsonBreakMember(
  body: string,
  error: unknown,
  members: readonly string[],
): EnvelopeMember | undefined {
  const offset = error instanceof JsonEvidenceError ? error.offset : undefined;
  if (offset === undefined) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectKey = false;
  let keyStart = -1;
  let member: EnvelopeMember | undefined;
  for (let index = 0; index < Math.min(offset, body.length); index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (keyStart >= 0) {
          const key = body.slice(keyStart, index);
          member = members.includes(key) ? (`$.${key}` as EnvelopeMember) : undefined;
          keyStart = -1;
        }
      }
    } else if (char === '"') {
      inString = true;
      if (depth === 1 && expectKey) {
        keyStart = index + 1;
        expectKey = false;
      }
    } else if (char === "{" || char === "[") {
      depth += 1;
      if (depth === 1) expectKey = char === "{";
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectKey = true;
      member = undefined;
    }
  }
  return depth >= 1 ? member : undefined;
}

/**
 * How each member arrived in the forwarded arguments: as its JSON value
 * itself, or as one JSON string holding that value's JSON. `null` is a
 * `qualityScore` sent as the JSON value `null`.
 */
export interface QualitySubmissionMemberEncoding {
  readonly evaluation: "object" | "string";
  readonly qualityScore: "object" | "null" | "string";
}

/** The two members a submission carries, as the host decoded them from the raw arguments. */
export interface QualitySubmissionMembers {
  readonly evaluation: Record<string, unknown>;
  readonly qualityScore: Record<string, unknown> | null;
  readonly memberEncoding: QualitySubmissionMemberEncoding;
  /**
   * UTF-8 bytes of the member strings the decoder read as JSON, for
   * diagnosis; 0 when no member arrived as a string. Every bound applies to
   * the raw outer bytes, which decoding never exceeds.
   */
  readonly innerBytes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type SubmissionMember = "evaluation" | "qualityScore";

/**
 * One member sent as a JSON string S. S is exactly the characters the strict
 * outer parse unescaped, so it is parsed once, as a whole document, by the
 * same strict parser: a repeated key, trailing text, a cut, or a raw control
 * character inside an inner string is refused at the member. The value is
 * never decoded a second time, so a string inside S stays a string, and the
 * member's own type check refuses it.
 */
function decodeMemberString(member: SubmissionMember, text: string): unknown {
  try {
    return parseJsonEvidence(text);
  } catch (error) {
    refuse(
      error instanceof JsonEvidenceError && error.code === "duplicate-key"
        ? rejectOutput("quality-submission-duplicate-key", `$.${member}`)
        : rejectOutput("quality-submission-json", `$.${member}`),
    );
  }
}

/**
 * Decode one `submit_quality_evaluation` call from the raw argument text the
 * serving stack forwarded. Never Pi's parsed or validated object: the
 * raw text is held to the same strict JSON as the text answer, so a
 * duplicate key, a raw line break, trailing text, a report passed as a third
 * argument, and a non-object root are each refused with their own code.
 * Missing text is a JSON refusal at `$`.
 *
 * `evaluation` and `qualityScore` may each arrive as one JSON string holding
 * the member's JSON, because some serving stacks stringify object arguments
 * (#1707). That string is decoded exactly once by the same strict parser, and
 * the decoded value must be what the member admits as a value: an object for
 * `evaluation`, an object or `null` for `qualityScore`. The root, and any
 * other member, is never read from a string.
 */
export function decodeQualitySubmission(raw: string | undefined): QualitySubmissionMembers {
  if (raw === undefined || !raw.trim()) refuse(rejectOutput("quality-submission-json", "$"));
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(raw);
  } catch (error) {
    refuse(submissionJsonBreak(raw, error));
  }
  if (!isPlainObject(parsed)) refuse(rejectOutput("quality-submission-shape", "$"));
  if (!hasExactly(parsed, QUALITY_ARTIFACT_ANSWER_KEYS)) {
    refuse(rejectOutput("quality-submission-shape", "$"), Object.keys(parsed));
  }
  let innerBytes = 0;
  const unwrap = (member: SubmissionMember): { value: unknown; stringified: boolean } => {
    const value = parsed[member];
    if (typeof value !== "string") return { value, stringified: false };
    innerBytes += Buffer.byteLength(value, "utf8");
    return { value: decodeMemberString(member, value), stringified: true };
  };
  const evaluation = unwrap("evaluation");
  if (!isPlainObject(evaluation.value)) {
    refuse(rejectOutput("quality-submission-shape", "$.evaluation"));
  }
  const qualityScore = unwrap("qualityScore");
  if (qualityScore.value !== null && !isPlainObject(qualityScore.value)) {
    refuse(rejectOutput("quality-submission-shape", "$.qualityScore"));
  }
  return {
    evaluation: evaluation.value,
    qualityScore: qualityScore.value,
    memberEncoding: {
      evaluation: evaluation.stringified ? "string" : "object",
      qualityScore: qualityScore.stringified
        ? "string"
        : qualityScore.value === null
          ? "null"
          : "object",
    },
    innerBytes,
  };
}

/**
 * The member strings of a submission's raw arguments, as the strict outer
 * parse unescaped them; empty when the text is not a strict JSON object.
 * Retention screens these too, because an escape inside a member string can
 * hide credential material from a screen of the raw text.
 */
export function submissionMemberStrings(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  return Object.values(parsed).filter((value): value is string => typeof value === "string");
}

/**
 * Assemble the candidate from an admitted submission and the reply to the
 * report ask. The report meets every rule the text answer's report meets,
 * under the submission's own codes, and the candidate passes the same member
 * checks, so both paths store the same candidate for the same members and
 * report.
 */
export function admitSubmittedQualityArtifact(
  members: QualitySubmissionMembers,
  reply: string,
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>,
): NonNullable<HarnessStepResult["qualityArtifactCandidate"]> {
  const report = reply.trim();
  return admitMembers(
    members.evaluation,
    members.qualityScore,
    admitReport(report, report, SUBMITTED_ANSWER_REPORT_CODES),
    selection,
  );
}

/** The JSON type a typed shell gives each member of the evaluator's submission. */
const SUBMISSION_MEMBER_TYPES: Readonly<Record<string, SubmissionMemberType>> = Object.freeze({
  evaluation: "object",
  qualityScore: ["object", "null"] as const,
});

/**
 * The submission tool's parameters for the route's recorded shell. The member
 * descriptions are catalog host text; the evaluation's also names the locked
 * profile asset and its digest from the selection receipt the prompt carries.
 */
export function qualitySubmissionParameters(
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>,
  argumentShell: "untyped" | "typed",
) {
  return buildSubmissionShell({
    keys: QUALITY_ARTIFACT_ANSWER_KEYS,
    argumentShell,
    descriptions: {
      evaluation: `${OUTPUT_HOST_TEXT["quality-submission-evaluation-description"]} Locked profile: quality/${selection.profileAssetPath} (sha256 ${selection.profilePayloadSha256}).`,
      qualityScore: OUTPUT_HOST_TEXT["quality-submission-quality-score-description"],
    },
    types: SUBMISSION_MEMBER_TYPES,
  });
}

/**
 * The final evaluator's answer tool on a route with a recorded answer
 * submission. Executing it only acknowledges the call: the host admits the
 * submission from the raw arguments when the turn settles, whether Pi ran,
 * refused, or blocked the call.
 */
export function createQualitySubmissionTool(input: {
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>;
  argumentShell: "untyped" | "typed";
}): ToolDefinition<any, any, any> {
  return {
    name: QUALITY_SUBMISSION_TOOL_NAME,
    label: "Submit quality evaluation",
    description: OUTPUT_HOST_TEXT["quality-submission-tool-description"],
    parameters: qualitySubmissionParameters(input.selection, input.argumentShell),
    async execute() {
      const details = {
        kind: "docsfab-quality-submission-acknowledgement" as const,
        message: OUTPUT_HOST_TEXT["quality-submission-acknowledgement"],
      };
      return { content: [{ type: "text", text: details.message }], details };
    },
  };
}

/**
 * Stand-in report for the advisory check of submitted members. The check
 * reads only the evaluation's technical trace; the content preflight it runs
 * first requires a report, which a submission does not carry yet.
 */
const ADVISORY_REPORT_STAND_IN = "# Advisory check of submitted members";

type QualityCandidateToolResult = {
  kind: "docsfab-quality-candidate-trace-validation";
  status: "passed" | "invalid";
  candidateSha256: string;
  violations: TechnicalFactTraceInspection["violations"];
  truncated: boolean;
};

function validationResult(
  candidateSha256: string,
  inspection: TechnicalFactTraceInspection,
): QualityCandidateToolResult {
  return {
    kind: "docsfab-quality-candidate-trace-validation",
    status: inspection.status,
    candidateSha256,
    violations: inspection.violations,
    truncated: inspection.truncated,
  };
}

function malformedResult(candidateSha256: string): QualityCandidateToolResult {
  return validationResult(candidateSha256, {
    status: "invalid",
    violations: [{ code: "malformed-candidate" }],
    truncated: false,
  });
}

/**
 * Advisory validation inside the evaluator's existing Pi session. The tool
 * neither stages nor admits the draft; the final host validator remains the
 * only quality-artifact authority.
 */
export function createQualityCandidateValidationTool(input: {
  selection: NonNullable<HarnessStepInput["qualityProfileSelection"]>;
  technicalVerification: VerificationResult;
  /**
   * On a route with a recorded answer submission, the tool takes the
   * submission's own arguments and decodes them from their raw text, looked
   * up by tool-call ID, with the submission's decoder.
   */
  submission?: {
    readonly argumentShell: "untyped" | "typed";
    readonly rawArguments: (toolCallId: string) => string | undefined;
  };
}): ToolDefinition<any, any, any> {
  const submission = input.submission;
  if (submission) {
    return {
      name: QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
      label: "Validate quality candidate trace",
      description: OUTPUT_HOST_TEXT["quality-submission-advisory-tool-description"],
      promptSnippet: OUTPUT_HOST_TEXT["quality-submission-advisory-prompt-snippet"],
      promptGuidelines: [
        OUTPUT_HOST_TEXT["quality-submission-advisory-guideline-arguments"],
        OUTPUT_HOST_TEXT["quality-submission-advisory-guideline-correct"],
      ],
      parameters: qualitySubmissionParameters(input.selection, submission.argumentShell),
      async execute(toolCallId) {
        const raw = submission.rawArguments(toolCallId) ?? "";
        const candidateSha256 = createHash("sha256").update(raw).digest("hex");
        let result: QualityCandidateToolResult;
        try {
          const members = decodeQualitySubmission(raw);
          const candidate = {
            evaluation: members.evaluation,
            qualityScore: members.qualityScore,
            reportMarkdown: ADVISORY_REPORT_STAND_IN,
            selectionSha256: input.selection.selectionSha256,
          };
          preflightQualityArtifactCandidateContent(candidate);
          const carried = carryAdmittedTechnicalLocators(candidate, input.technicalVerification);
          result = validationResult(
            candidateSha256,
            inspectTechnicalFactTrace(carried.evaluation, input.technicalVerification),
          );
        } catch {
          result = malformedResult(candidateSha256);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    };
  }
  return {
    name: QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
    label: "Validate quality candidate trace",
    description:
      "Check a draft quality artifact answer against the admitted technical fact trace. " +
      "The result is advisory and content-free; submit the final corrected response normally.",
    promptSnippet: "Validate a draft quality artifact candidate before final submission",
    promptGuidelines: [
      "Pass the exact draft response in candidateJson.",
      "Correct every returned violation before submitting the final response.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidateJson"],
      properties: {
        candidateJson: {
          type: "string",
          description:
            "Exact draft response: the evaluation and qualityScore JSON object followed by the report Markdown.",
        },
      },
    },
    async execute(_id, rawParams) {
      const parameterObject =
        rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : undefined;
      const candidateJson =
        parameterObject &&
        Object.keys(parameterObject).sort().join(",") === "candidateJson" &&
        typeof parameterObject.candidateJson === "string"
          ? parameterObject.candidateJson
          : "";
      const candidateSha256 = createHash("sha256").update(candidateJson).digest("hex");
      let result: QualityCandidateToolResult;
      if (
        !candidateJson ||
        Buffer.byteLength(candidateJson, "utf8") > QUALITY_CANDIDATE_JSON_MAX_BYTES
      ) {
        result = malformedResult(candidateSha256);
      } else {
        try {
          const candidate = decodeQualityArtifactResponse(candidateJson, input.selection);
          preflightQualityArtifactCandidateContent(candidate);
          // Report what the final host validator will see, after it carries locators.
          const carried = carryAdmittedTechnicalLocators(candidate, input.technicalVerification);
          result = validationResult(
            candidateSha256,
            inspectTechnicalFactTrace(carried.evaluation, input.technicalVerification),
          );
        } catch {
          result = malformedResult(candidateSha256);
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
