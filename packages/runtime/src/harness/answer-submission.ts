// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared seam for submitting a closed-schema answer through a host tool
 * call: which path a step's answer takes, the tool's
 * parameter shell, the raw argument text the serving stack forwarded, and the
 * one-submission rule. Only what any closed-schema step would share lives
 * here; the final quality evaluator's own tool, report turn, and codes stay in
 * `quality-candidate-tool.ts`.
 */

import type { AnswerSubmissionOption } from "../config/answer-submission.js";
import type { InstalledAnswerSubmission } from "../model-composition/types.js";
import type { InferenceAnswerPath, InferenceAnswerPathReason } from "../records/contracts.js";
import type { WorkflowDefinition, WorkflowStep } from "../workflow-contracts/contracts.js";

export const QUALITY_SUBMISSION_TOOL_NAME = "submit_quality_evaluation" as const;
export const QUALITY_ANSWER_RECORD_TOOL_NAME = "submit_answer_record" as const;

export type AnswerPath = InferenceAnswerPath;

export type AnswerPathReason = InferenceAnswerPathReason;

export interface ResolvedAnswerPath {
  readonly path: AnswerPath;
  readonly reason: AnswerPathReason;
}

/**
 * Whether the step's answer can be submitted through a tool call: the bound
 * final quality evaluator of review-documentation, the only step whose answer
 * contract has a tool-call form today.
 */
export function answerSubmissionApplies(input: {
  readonly workflow: Pick<WorkflowDefinition, "name">;
  readonly step: Pick<WorkflowStep, "id" | "skill" | "kind" | "mode">;
  readonly qualityBound: boolean;
}): boolean {
  return (
    input.qualityBound &&
    input.workflow.name === "review-documentation" &&
    input.step.id === "evaluate-document-quality" &&
    input.step.skill === "evaluate-document-quality" &&
    (input.step.kind ?? "inference") === "evaluate" &&
    input.step.mode === "read-only"
  );
}

/**
 * The one answer-path decision for a step. The runner resolves it once and
 * hands the result to every consumer: both tool grants and the response
 * contract. `undefined` for a step that has no tool-call answer form.
 */
export function resolveAnswerPath(input: {
  readonly capability: InstalledAnswerSubmission | undefined;
  readonly option: AnswerSubmissionOption;
  readonly workflow: Pick<WorkflowDefinition, "name">;
  readonly step: Pick<WorkflowStep, "id" | "skill" | "kind" | "mode">;
  readonly qualityBound: boolean;
  readonly toolCeiling: readonly string[] | undefined;
}): ResolvedAnswerPath | undefined {
  if (!answerSubmissionApplies(input)) return undefined;
  if (input.option === "text-final") return { path: "text-final", reason: "operator-override" };
  if (!input.capability) return { path: "text-final", reason: "not-recorded" };
  if (
    input.toolCeiling !== undefined &&
    !input.toolCeiling.includes(QUALITY_SUBMISSION_TOOL_NAME)
  ) {
    return { path: "text-final", reason: "tool-not-granted" };
  }
  return { path: "tool-call", reason: "recorded-route" };
}

/** A JSON Schema type a typed shell declares for one member. */
export type SubmissionMemberType = "object" | readonly ["object", "null"];

/**
 * The submission tool's parameters. The member set is the answer's own key
 * set. The `untyped` shell gives each member only its description; the
 * `typed` shell adds the member's JSON type. Neither declares `required` or
 * closes the key set: admission reads the raw argument text, never the
 * object Pi validated or coerced, so the shell only guides the model and the
 * serving stack's parser.
 */
export function buildSubmissionShell(input: {
  readonly keys: readonly string[];
  readonly argumentShell: InstalledAnswerSubmission["argumentShell"];
  readonly descriptions: Readonly<Record<string, string>>;
  readonly types: Readonly<Record<string, SubmissionMemberType>>;
}): { type: "object"; properties: Record<string, Record<string, unknown>> } {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const key of input.keys) {
    const description = input.descriptions[key];
    const type = input.types[key];
    if (description === undefined || type === undefined) {
      throw new Error("The submission shell is missing a member description or type.");
    }
    properties[key] =
      input.argumentShell === "typed"
        ? { type: typeof type === "string" ? type : [...type], description }
        : { description };
  }
  return { type: "object", properties };
}

/**
 * The raw argument text of one turn's tool calls, keyed by the call's content
 * position in the assistant message, exactly as the serving stack streamed it.
 * Pi parses and then drops its own copy at the end of each call, so this
 * capture is the only place the forwarded bytes survive.
 */
export class RawToolCallCapture {
  private readonly calls = new Map<number, { name: string; text: string; charged: number }>();
  private readonly positions = new Map<string, number>();

  /** Forget the previous turn's calls. */
  public reset(): void {
    this.calls.clear();
    this.positions.clear();
  }

  /** Bind a finished call's ID to its content position, for a lookup by ID. */
  public bind(contentIndex: number, toolCallId: string): void {
    this.positions.set(toolCallId, contentIndex);
  }

  /** Captured text of this turn's call with `toolCallId`, or `undefined`. */
  public textOfCall(toolCallId: string): string | undefined {
    const position = this.positions.get(toolCallId);
    return position === undefined ? undefined : this.textAt(position);
  }

  /**
   * The captured text of the call at `contentIndex` not yet returned by this
   * method, so each byte is charged to the response bound exactly once even
   * when the call's name arrives after its first text.
   */
  public takeUncharged(contentIndex: number): string {
    const entry = this.calls.get(contentIndex);
    if (!entry) return "";
    const uncharged = entry.text.slice(entry.charged);
    entry.charged = entry.text.length;
    return uncharged;
  }

  /** Note a call; its name can arrive after its first event. */
  public observe(contentIndex: number, name: string | undefined): void {
    const entry = this.calls.get(contentIndex) ?? { name: "", text: "", charged: 0 };
    if (name) entry.name = name;
    this.calls.set(contentIndex, entry);
  }

  public append(contentIndex: number, name: string | undefined, delta: string): void {
    this.observe(contentIndex, name);
    this.calls.get(contentIndex)!.text += delta;
  }

  public nameAt(contentIndex: number): string | undefined {
    return this.calls.get(contentIndex)?.name || undefined;
  }

  /** Captured text of the call at `contentIndex`, or `undefined` when none arrived. */
  public textAt(contentIndex: number): string | undefined {
    return this.calls.get(contentIndex)?.text;
  }

  /** UTF-8 bytes captured so far for every call named `name` in this turn. */
  public bytesOf(name: string): number {
    let bytes = 0;
    for (const entry of this.calls.values()) {
      if (entry.name === name) bytes += Buffer.byteLength(entry.text, "utf8");
    }
    return bytes;
  }

  public has(name: string): boolean {
    return [...this.calls.values()].some((entry) => entry.name === name);
  }
}

/** One tool call of a settled assistant message, with its content position. */
export interface SettledToolCall {
  readonly id: string;
  readonly name: string;
  /** Position among the message's tool calls, as the lease orders them. */
  readonly ordinal: number;
  /** Position in the message's content, as the stream indexed it. */
  readonly contentIndex: number;
}

/** The tool calls of a settled assistant message, with both positions. */
export function settledToolCalls(message: object): SettledToolCall[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const calls: SettledToolCall[] = [];
  content.forEach((block, contentIndex) => {
    if (!block || typeof block !== "object") return;
    const item = block as Record<string, unknown>;
    if (item.type !== "toolCall" || typeof item.id !== "string" || typeof item.name !== "string") {
      return;
    }
    calls.push({ id: item.id, name: item.name, ordinal: calls.length, contentIndex });
  });
  return calls;
}

/**
 * The one submission a turn offers: the lowest-ordinal call to `toolName`.
 * Any later call to it in the same turn is denied and never decoded.
 */
export function firstSubmissionCall(
  calls: readonly SettledToolCall[],
  toolName: string,
): SettledToolCall | undefined {
  return calls.find((call) => call.name === toolName);
}
