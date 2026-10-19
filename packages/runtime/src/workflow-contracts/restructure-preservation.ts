// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-owned meaning of the restructure preservation obligations. Without it,
 * a planner can read "reorder sections" and "preserve anchors" as conflicting
 * and stop with `needs-input` before any write.
 *
 * Preservation is about the destination, not the position. Repeated heading
 * text gets page-order-numbered anchors, so a reorder can move `#example` to
 * another section; the plan updates in-scope links or asks. No explicit-anchor
 * remedy is offered because the structural link check reads neither `{#id}`
 * attributes nor MyST labels, and an HTML anchor can collide with the
 * generated id.
 *
 * These sentences are the single source of that meaning; the planner contract
 * (`harness/pi-session.ts`) renders them. They define interpretation, not a
 * reply shape or host-enforced rule, so they are not a `config/model-output/`
 * catalog entry.
 */

export const RESTRUCTURE_ANCHOR_PRESERVATION =
  "Preserving an anchor or link means the anchor still exists and still identifies the same section, and every link to it still resolves to that section; it does not fix where the section sits on the page. Reordering sections within a page, without renaming their headings, preserves the anchors of headings whose text is unique on the page and the links to them, and keeping a page at its path with its navigation unchanged keeps its route, so such a reorder does not conflict with preserving anchors, links, or routes.";

export const RESTRUCTURE_REPEATED_HEADING_ANCHORS =
  "Where heading text repeats on a page, its generated anchors are numbered in page order, such as example and example-1, so a reorder can shift a numbered anchor to a different section while every link still resolves. The plan must update the links that point at a shifted anchor within the request's scope; if it cannot do that within the request's scope, that is a genuine conflict and needs-input is allowed.";

export const RESTRUCTURE_UNMENTIONED_SECTION_ORDER =
  "A placement the request states explicitly, such as the requested order, to the top, to the end, or after another section, wins. Sections the request does not name keep their relative order, and a section that was last and is not named stays last. That placement is not an open decision and is not a reason to return needs-input.";

export const RESTRUCTURE_GENUINE_CONFLICT =
  "Return needs-input only for a genuine conflict or gap, for example when the request contradicts itself, asks to delete or rewrite content it also says to preserve, requires a page, route, or source this run cannot bind, or depends on a decision or dependency that is not available. Name the conflicting obligations in the summary.";

/** The restructure planner's preservation block, in render order. */
export const RESTRUCTURE_PRESERVATION_CONTRACT: readonly string[] = Object.freeze([
  "Restructure preservation semantics (host-owned):",
  RESTRUCTURE_ANCHOR_PRESERVATION,
  RESTRUCTURE_REPEATED_HEADING_ANCHORS,
  RESTRUCTURE_UNMENTIONED_SECTION_ORDER,
  RESTRUCTURE_GENUINE_CONFLICT,
]);
