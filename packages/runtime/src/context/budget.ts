// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Context packet budgets, sized from the input window of the model that runs
 * the step.
 *
 * A packet is pasted into the step's prompt, so its budget is a declared share
 * of that window (`config/limits/context.yaml`), never a fixed figure: the same
 * share gives a 65,536-token model and a 1,050,000-token model proportionate
 * packets. Every field derives from a catalog limit, so a host raises a budget
 * with an override instead of a code change.
 */
import { limit, type ResolveLimitsOptions } from "../config/limits.js";
import {
  admittedInputWindowTokens,
  type AdmittedInputWindowSource,
} from "../model/admitted-input-window.js";
import type { ContextLevel } from "../workflow-contracts/contracts.js";
import { CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN, type ContextBudget } from "./contracts.js";

export const CONTEXT_PACKET_LIMIT_NAMES = Object.freeze({
  localInputShare: "context.localPacketInputShareBasisPoints",
  corpusInputShare: "context.corpusPacketInputShareBasisPoints",
  fallbackInputTokens: "context.packetFallbackInputTokens",
  maxDepth: "context.packetMaxDepth",
} as const);

export type ContextPacketShareLimitName =
  | typeof CONTEXT_PACKET_LIMIT_NAMES.localInputShare
  | typeof CONTEXT_PACKET_LIMIT_NAMES.corpusInputShare;

/** The unit's own scale, not an operational bound; the bound is the catalog's share. */
const BASIS_POINTS_PER_WHOLE = 10_000;

/**
 * The packet records a compile-duration budget, and the only compile-latency
 * bound DocsFab enforces is the hosted wait, so the packet records that one.
 * The local preflight measures its latency and never stops on it.
 */
const COMPILE_DURATION_LIMIT = "hostInvoker.contextPreflightBudgetMs";

/** The catalog share that sizes a packet of this budget class. */
export function contextPacketShareLimitName(
  budgetClass: ContextBudget["class"],
): ContextPacketShareLimitName {
  return budgetClass === "corpus"
    ? CONTEXT_PACKET_LIMIT_NAMES.corpusInputShare
    : CONTEXT_PACKET_LIMIT_NAMES.localInputShare;
}

/** A model input window a caller may size packets from: a positive safe integer of tokens. */
export function isContextPacketInputWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The part of a bound model's execution profile that says which window
 * DocsFab may size packets from: the source `admittedInputWindowTokens` reads.
 */
export type ContextPacketWindowSource = AdmittedInputWindowSource;

/**
 * The input window a bound profile lets packets be sized from. It is
 * `admittedInputWindowTokens`, the one rule source reads use too, so packets
 * and source reads count the same windows: an installed composition's window,
 * whatever its profile metadata says, or a profile whose metadata is current.
 * Provider admission, a profile that matches no installed composition and whose
 * metadata is unknown or stale (such as the placeholder `docsfab setup` writes),
 * or no profile yields `undefined`, and the packet uses
 * `context.packetFallbackInputTokens`. Pass the bound execution profile, never
 * the endpoint configuration it was bound from.
 */
export function contextPacketInputWindow(
  bound: ContextPacketWindowSource | null | undefined,
): number | undefined {
  return admittedInputWindowTokens(bound);
}

/**
 * The budget of one packet at `level`. `inputTokens` is the bound model's
 * attested input window (`contextPacketInputWindow`).
 *
 * The window is never smaller than `context.packetFallbackInputTokens`: with
 * no window, or a smaller one, the packet is sized from that fallback, so no
 * setup gets a smaller packet than the fallback gives. At the default, that is
 * the smallest window an installed composition seals, where the shares give
 * the former fixed budgets.
 *
 * The estimated-token budget is the level's share of the window. The byte
 * budget is the same bound in bytes (a packet's estimate is one token per
 * `CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN` bytes), and the node, edge, and
 * path counts equal the token budget: every element costs more than one
 * estimated token, so no count binds before the token budget does.
 */
export function contextPacketBudget(
  level: ContextLevel,
  inputTokens?: number,
  options?: ResolveLimitsOptions,
): ContextBudget {
  if (inputTokens !== undefined && !isContextPacketInputWindow(inputTokens)) {
    throw new Error(
      `A context packet budget needs the model input window as a positive whole number of tokens; received ${String(inputTokens)}.`,
    );
  }
  const budgetClass: ContextBudget["class"] = level === "corpus" ? "corpus" : "local";
  const fallback = limit(CONTEXT_PACKET_LIMIT_NAMES.fallbackInputTokens, options).value;
  const window = Math.max(inputTokens ?? fallback, fallback);
  const share = limit(contextPacketShareLimitName(budgetClass), options).value;
  const maxEstimatedTokens = Math.max(1, Math.floor((window * share) / BASIS_POINTS_PER_WHOLE));
  return {
    class: budgetClass,
    maxNodes: maxEstimatedTokens,
    maxEdges: maxEstimatedTokens,
    maxPaths: maxEstimatedTokens,
    maxDepth: limit(CONTEXT_PACKET_LIMIT_NAMES.maxDepth, options).value,
    maxBytes: maxEstimatedTokens * CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN,
    maxEstimatedTokens,
    maxDurationMs: limit(COMPILE_DURATION_LIMIT, options).value,
  };
}
