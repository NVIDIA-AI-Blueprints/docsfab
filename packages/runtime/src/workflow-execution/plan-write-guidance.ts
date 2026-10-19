// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a documentation plan may write, stated to the planner before it plans:
 * the roots plan admission checks every planned write against, the Markdown or
 * MDX page shape, and a restructure's navigation files inside the roots. The
 * statement is guidance, so a planner that ignores it is still refused by plan
 * admission; it adds no check of its own.
 */

/** The write scope a planner is told, as plan admission resolves it. */
export interface PlanWriteGuidanceV1 {
  /** Directory roots, each ending in `/`, that cover the pages under them. */
  readonly directoryRoots: readonly string[];
  /** File roots, each covering exactly that path. */
  readonly fileRoots: readonly string[];
  /** Supported navigation files present in the base workspace and inside the roots. */
  readonly navigationFiles: readonly string[];
  /** Validated request targets that also pass the plan write scope. They grant no additional paths. */
  readonly boundTargets?: readonly string[];
}

export const PLAN_WRITE_GUIDANCE_HEADER =
  "Documentation write scope (authoritative, computed by the host before this step):";

/**
 * The planner prompt block for `guidance`. It opens with a blank line, so it
 * never joins a host-owned response contract section above it.
 */
export function planWriteGuidancePrompt(guidance: PlanWriteGuidanceV1): string {
  if (guidance.boundTargets?.some((path) => path.endsWith(".rst"))) {
    return [
      "",
      "",
      PLAN_WRITE_GUIDANCE_HEADER,
      "The plan may update only the one host-bound existing RST page named below. RST creation, restructuring, and any second write target are unsupported.",
      `Host-bound request target: ${JSON.stringify(guidance.boundTargets)}`,
      "Keep the page in update mode and bind its source evidence. The writer will propose one top-level paragraph or insertion slot; the host applies and verifies it.",
      "",
      "",
    ].join("\n");
  }
  // Roots passed the write-root grammar, and the navigation file is a fixed
  // adapter location, so all of them are safe to name.
  return [
    "",
    "",
    PLAN_WRITE_GUIDANCE_HEADER,
    "The plan may write only Markdown or MDX pages, paths that end in .md or .mdx, inside the run's documentation roots. Plan admission refuses a plan that writes any other path, before any write step.",
    "Instruction and hidden files are refused unless the operator's request names them.",
    `Directory roots, covering Markdown or MDX pages subject to protected-path rules: ${JSON.stringify(guidance.directoryRoots)}`,
    `File roots, each covering exactly that one page: ${JSON.stringify(guidance.fileRoots)}`,
    ...(guidance.boundTargets && guidance.boundTargets.length > 0
      ? [
          `Host-bound request targets authorized under these roots: ${JSON.stringify(guidance.boundTargets)}`,
          "A missing parent directory under an authorized root does not make a bound target ambiguous.",
        ]
      : []),
    ...(guidance.navigationFiles.length > 0
      ? [
          `This restructure may also write these navigation files present as regular files in the base workspace and inside the roots: ${JSON.stringify(guidance.navigationFiles)}.`,
        ]
      : []),
    "Give no other path a mutating disposition: not a path outside these roots, and not a file that is not a Markdown or MDX page even under a root, such as an OpenAPI or other YAML or JSON specification, a configuration file, or source code.",
    "For a Markdown or MDX page outside these roots, name each page in the summary and say to add the page or its directory to documentationRoots in .docsfab.json, commit that file, and start a new run. Keep the page retain or out-of-scope, or leave it out of pages, until the roots cover it.",
    "For another file that is not a Markdown or MDX page, such as an OpenAPI specification, keep it retain or out-of-scope, or leave it out of pages, plan the pages inside the roots that the change affects, and say in the summary which file needs a change DocsFab does not make.",
    "",
    "",
  ].join("\n");
}
