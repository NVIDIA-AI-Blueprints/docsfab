// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Independent ordering examples for the shipped preservation contract. */
export const REORDER_INSTRUCTION =
  "Reorder docs/guide.md for a first visit: Start, Examples, Reports, Flags, then Appendix. Keep the headings, facts, links, and other files intact.";
export const FIXTURE_GUIDE_SECTIONS = [
  "Appendix",
  "Reports",
  "Start",
  "Examples",
  "Flags",
  "Support",
] as const;
export const STATED_PLACEMENT_CASES = [
  {
    request: "the first-visit sequence with Support left last",
    placed: { top: ["Start", "Examples", "Reports", "Flags", "Appendix"] },
    expected: ["Start", "Examples", "Reports", "Flags", "Appendix", "Support"],
  },
  {
    request: "place Flags before all other sections",
    placed: { top: ["Flags"] },
    expected: ["Flags", "Appendix", "Reports", "Start", "Examples", "Support"],
  },
];
