// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  presentCollection,
  presentResult,
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type CollectionPresentationFacts,
  type PresentationCapabilities,
  type PresentationDocument,
  type PresentationDetail,
  type PresentationField,
  type ResultPresentationFacts,
} from "../operator/presentation/index.js";
import { PUBLIC_COMMAND_REGISTRY } from "./command-registry.js";
import { listWorkflows } from "../workflow-registry/catalog.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import type { OfflineProductTestResult } from "../product-test.js";
import type { CliFormatOptions } from "../operator/cli-format.js";

const known = (value: string) => ({ state: "known" as const, value });

/** The process boundary owns terminal detection; tests can pass explicit capabilities. */
export function renderCliPresentation(
  document: PresentationDocument,
  capabilities: PresentationCapabilities = resolveProcessPresentationCapabilities(),
): string {
  return renderPresentation(document, capabilities).stdout.trimEnd();
}

export function resolveCliPresentationCapabilities(
  options: CliFormatOptions = {},
): PresentationCapabilities {
  return resolveProcessPresentationCapabilities({
    ...(options.tty === undefined
      ? {}
      : { stdout: { isTTY: options.tty }, stderr: { isTTY: options.tty } }),
    environment: {
      ...(options.noColor === undefined ? {} : { noColorPresent: options.noColor }),
      ...(options.forceColor === undefined ? {} : { forceColor: options.forceColor }),
      ...(options.forceColorDisabled === undefined
        ? {}
        : { forceColorDisabled: options.forceColorDisabled }),
      ...(options.ci === undefined ? {} : { ci: options.ci }),
      ...(options.termDumb === undefined ? {} : { termDumb: options.termDumb }),
    },
  });
}

function field(label: string, value: string): PresentationField {
  return { label, evidence: known(value) };
}

export function generalHelpPresentation(): PresentationDocument {
  const facts: CollectionPresentationFacts = {
    title: "DocsFab — governed documentation workflows on Pi",
    entries: [],
    sections: [
      {
        title: "Usage",
        text: ["docsfab <command> [options]"],
      },
      {
        title: "Start here",
        fields: [
          field("Setup", "Configure the supported model profile."),
          field("Check", "Check whether a selected repository can proceed."),
          field("Find", "List available documentation workflows."),
          field("Run", "Start a static, read-only repository review."),
        ],
        actions: [
          {
            kind: "argv",
            label: "Configure a model profile",
            executable: "docsfab",
            args: ["setup"],
          },
          { kind: "argv", label: "List workflows", executable: "docsfab", args: ["list"] },
          {
            kind: "argv",
            label: "Run a read-only review",
            executable: "docsfab",
            args: ["run", "review-documentation"],
          },
        ],
      },
      {
        title: "Delivery choices",
        fields: [
          field("--patch-only", "Retain a local patch without applying or publishing it."),
          field("--dry-run", "Preview CLI selection without inspecting or validating the target."),
          field(
            "default",
            "Authoring workflows open one draft merge request after prerequisites pass.",
          ),
        ],
      },
      {
        title: "Commands",
        fields: PUBLIC_COMMAND_REGISTRY.map((command) => field(command.name, command.description)),
      },
      {
        title: "Command help",
        fields: [
          field("General", "docsfab help"),
          field("One command", "docsfab help <command> [<subcommand>]"),
          field("Shortcut", "docsfab <command> --help (or -h)"),
          field("Detailed examples", "docsfab run --help"),
        ],
      },
      {
        title: "Reference",
        text: ["See the Runtime CLI and Configuration guide for the full flag reference."],
      },
    ],
    attention: null,
  };
  return presentCollection(facts);
}

export function workflowListPresentation(
  workflows: readonly WorkflowDefinition[] = listWorkflows(),
): PresentationDocument {
  const facts: CollectionPresentationFacts = {
    title: "Available workflows",
    entries: workflows.map((workflow) => field(workflow.name, workflow.title)),
    ...(workflows.length === 0
      ? {
          sections: [
            {
              title: "Empty catalog",
              text: [
                "No workflows are available. Check that the DocsFab runtime and workflow catalog are installed.",
              ],
              actions: [
                {
                  kind: "argv" as const,
                  label: "Show installation help",
                  executable: "docsfab",
                  args: ["help", "setup"],
                },
              ],
            },
          ],
        }
      : {
          actions: workflows.map((workflow) => ({
            kind: "argv" as const,
            label: `Plan ${workflow.name}`,
            executable: "docsfab",
            args: ["plan", workflow.name],
          })),
        }),
    attention: null,
  };
  return presentCollection(facts);
}

export function workflowPlanPresentation(workflow: WorkflowDefinition): PresentationDocument {
  const facts: ResultPresentationFacts = {
    title: workflow.title,
    summary: `Plan for ${workflow.name}`,
    outcome: { label: "Outcome", evidence: known(workflow.outcome) },
    effects: workflow.steps.map((step, index) =>
      field(`Step ${index + 1}`, `${step.title} (${step.mode})`),
    ),
    primaryAction: {
      kind: "argv",
      label: `Run ${workflow.name}`,
      executable: "docsfab",
      args: ["run", workflow.name],
    },
    attention: null,
  };
  return presentResult(facts);
}

export function offlineProductTestPresentation(
  result: OfflineProductTestResult,
  detail: PresentationDetail = "normal",
): PresentationDocument {
  const facts: ResultPresentationFacts = {
    title: "Offline product test",
    summary: "The deterministic product simulation passed.",
    outcome: { label: "Outcome", evidence: known(result.status) },
    scope: {
      label: "Scope",
      evidence: known(
        "Synthetic documentation change; fake provider and GitLab boundaries; no real external writes.",
      ),
    },
    statusPlanes: [
      { label: "Execution", evidence: known("succeeded") },
      { label: "Publication", evidence: known("simulated") },
    ],
    effects: [
      { ...field("Credentials", result.isolation.credentials), detail: "quiet" },
      { ...field("Network", result.isolation.network), detail: "quiet" },
      { ...field("Source checkout", result.isolation.sourceCheckout), detail: "quiet" },
      {
        ...field("Checks", `${result.validation.checkCount} synthetic validation checks passed`),
        detail: "quiet",
      },
      {
        ...field("Simulated tracker", `${result.tracker.status}; no external tracker write`),
        detail: "quiet",
      },
      field(
        "Simulated publication",
        `draft MR; ${result.publication.externalMutationCount} fake external mutation; none outside this test`,
      ),
      field(
        "Retry",
        `${result.retry.status}; ${result.retry.externalMutationCount} fake mutation total`,
      ),
      { ...field("Record digest", result.sha256), detail: "quiet" },
    ],
    sections: [
      {
        title: "Simulated steps",
        fields: result.steps.map((step) => field(step.id, step.status)),
      },
      {
        title: "Synthetic result",
        fields: [
          field(
            "Patch",
            `${result.patch.byteLength} bytes; ${result.patch.changedPaths.join(", ")}`,
          ),
          field("Validation state digest", result.validation.stateSha256),
          field("Record digest", result.sha256),
        ],
      },
    ],
    attention: null,
  };
  return presentResult(facts, { detail });
}
