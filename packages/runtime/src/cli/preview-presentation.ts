// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  presentResult,
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type PresentationAction,
  type PresentationDetail,
  type ResultPresentationFacts,
  type RenderedPresentation,
} from "../operator/index.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";

/** Project a command-owned preview through the common human result renderer. */
export function renderCliPreview(
  facts: ResultPresentationFacts,
  detail: PresentationDetail = "normal",
): RenderedPresentation {
  return renderPresentation(
    presentResult(facts, { detail }),
    resolveProcessPresentationCapabilities(),
  );
}

/** Write one complete human preview message on each stream used by the view. */
export function printCliPreview(
  facts: ResultPresentationFacts,
  detail: PresentationDetail = "normal",
): void {
  const rendered = renderCliPreview(facts, detail);
  if (rendered.stdout !== "") console.log(rendered.stdout.trimEnd());
  if (rendered.stderr !== "") console.error(rendered.stderr.trimEnd());
}

export function previewField(
  label: string,
  value: string,
  options: {
    readonly importance?: "ordinary" | "material";
    readonly detail?: PresentationDetail;
  } = {},
): ResultPresentationFacts["outcome"] {
  return {
    label,
    evidence: { state: "known", value },
    ...(options.importance === undefined ? {} : { importance: options.importance }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  };
}

export function previewAction(
  label: string,
  executable: string,
  args: readonly string[],
): PresentationAction {
  return { kind: "argv", label, executable, args };
}

export function workflowPreviewFacts(input: {
  readonly workflow: WorkflowName;
  readonly repositoryPath: string;
  readonly wouldWrite: boolean;
  readonly wouldPublish: boolean;
  readonly supportingSummary?: string;
  readonly title?: string;
  readonly writeLabel?: string;
  readonly publishLabel?: string;
  readonly readinessLabel?: string;
  readonly nextActionLabel: string;
  readonly nextArguments: readonly string[];
}): ResultPresentationFacts {
  return {
    title: input.title ?? `Preview: ${input.workflow}`,
    outcome: previewField("Workflow", input.workflow, { detail: "quiet" }),
    scope: previewField("Repository", input.repositoryPath, {
      detail: "quiet",
      importance: "material",
    }),
    summary: getWorkflow(input.workflow).outcome,
    effects: [
      previewField(
        input.writeLabel ?? "Next run would write",
        input.wouldWrite ? "documentation" : "nothing",
        {
          detail: "quiet",
          importance: "material",
        },
      ),
      previewField(
        input.publishLabel ?? "Next run would publish",
        input.wouldPublish ? "a draft merge request" : "nothing",
        {
          detail: "quiet",
          importance: "material",
        },
      ),
    ],
    limitations: [
      previewField(
        input.readinessLabel ?? "Selection preview",
        "Repository readiness has not been checked.",
        {
          detail: "quiet",
          importance: "material",
        },
      ),
      ...(input.wouldPublish
        ? [
            previewField(
              "Publication prerequisites",
              "Requires an origin remote (or --remote), authenticated glab, and permission to push and create a merge request.",
              { detail: "quiet", importance: "material" },
            ),
          ]
        : []),
    ],
    sections:
      input.supportingSummary === undefined
        ? []
        : [{ title: "Route rationale", text: [input.supportingSummary], detail: "normal" }],
    primaryAction: previewAction(input.nextActionLabel, "docsfab", input.nextArguments),
    attention: null,
  };
}

export function needsInputPreviewFacts(input: {
  readonly request: string;
  readonly reason: string;
  readonly message: string;
  readonly nextAction: string;
  readonly admissionOffer?: string;
  readonly choices?: readonly string[];
}): ResultPresentationFacts {
  return {
    title: "Outcome route: needs-input",
    outcome: previewField("Outcome", "needs-input", { detail: "quiet" }),
    summary: input.message,
    scope: previewField("Original request", input.request, {
      detail: "quiet",
      importance: "material",
    }),
    limitations: [
      previewField("Reason", input.reason, { detail: "quiet", importance: "material" }),
      previewField("Authority", "No workflow or authority was selected.", {
        detail: "quiet",
        importance: "material",
      }),
    ],
    sections: [
      ...(input.choices === undefined
        ? []
        : [
            {
              title: "Choices",
              detail: "quiet" as const,
              importance: "material" as const,
              fields: input.choices.map((choice, index) =>
                previewField(`Choice ${index + 1}`, choice, {
                  detail: "quiet",
                  importance: "material",
                }),
              ),
            },
          ]),
      ...(input.admissionOffer === undefined
        ? []
        : [
            {
              title: "Available catalog workflows",
              text: [input.admissionOffer],
              detail: "quiet" as const,
              importance: "material" as const,
            },
          ]),
    ],
    attention: { message: input.message },
    primaryAction: { kind: "instruction", text: input.nextAction },
  };
}

/** Remove output/preview switches while preserving every admitted input token. */
export function nextInvocationArguments(
  args: readonly string[],
  omit: readonly string[],
  valueOptions: readonly string[],
): string[] {
  const omitted = new Set([...omit, "--json"]);
  const takesValue = new Set(valueOptions);
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      next.push(...args.slice(index));
      break;
    }
    if (argument.includes("=") && argument.startsWith("--")) {
      if (!omitted.has(argument.slice(0, argument.indexOf("=")))) next.push(argument);
      continue;
    }
    if (omitted.has(argument)) continue;
    next.push(argument);
    if (takesValue.has(argument) && args[index + 1] !== undefined) {
      next.push(args[index + 1]!);
      index += 1;
    }
  }
  return next;
}
