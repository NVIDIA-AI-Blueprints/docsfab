// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  generalHelpPresentation,
  offlineProductTestPresentation,
  renderCliPresentation,
  workflowListPresentation,
  workflowPlanPresentation,
} from "../src/cli/discovery-presentation.js";
import { PUBLIC_COMMAND_REGISTRY } from "../src/cli/command-registry.js";
import { getWorkflow, listWorkflows } from "../src/workflow-registry/catalog.js";
import { runOfflineProductTest, serializeOfflineProductTest } from "../src/product-test.js";
import { resolvePresentationCapabilities } from "../src/operator/presentation/index.js";

const plain = resolvePresentationCapabilities({
  stdout: { isTTY: false, columns: 26 },
  stderr: { isTTY: false, columns: 26 },
  environment: { noColorPresent: true, forceColor: false, ci: true, termDumb: true },
  unicode: false,
});

const normalizeOutput = (output: string): string => output.replace(/\s+/gu, " ");

describe("shared CLI discovery presentations", () => {
  it("keeps help registry-derived and puts common actions before the reference catalog", () => {
    const output = normalizeOutput(renderCliPresentation(generalHelpPresentation(), plain));

    for (const command of PUBLIC_COMMAND_REGISTRY) expect(output).toContain(command.name);
    expect(output.indexOf("Delivery choices")).toBeLessThan(output.indexOf("Commands"));
    expect(output).toContain("'docsfab' 'list'");
    expect(output).toContain("'docsfab' 'setup'");
  });

  it("lists every installed workflow, supports long names and contextual empty results", () => {
    const workflows = listWorkflows();
    const output = normalizeOutput(
      renderCliPresentation(workflowListPresentation(workflows), plain),
    );

    for (const workflow of workflows) {
      expect(output).toContain(workflow.name);
      expect(output).toContain(`'docsfab' 'plan' '${workflow.name}'`);
    }
    expect(output.replace(/\s+/gu, "")).toContain(`'docsfab''plan''${workflows[0]?.name ?? ""}'`);

    const empty = normalizeOutput(renderCliPresentation(workflowListPresentation([]), plain));
    expect(empty).toContain("Empty catalog");
    expect(empty).toContain(
      "No workflows are available. Check that the DocsFab runtime and workflow catalog are installed.",
    );
    expect(empty).toContain("'docsfab' 'help' 'setup'");
  });

  it("shows plan outcome and step effects without exposing skill identifiers", () => {
    const workflow = getWorkflow("create-documentation");
    const output = normalizeOutput(
      renderCliPresentation(workflowPlanPresentation(workflow), plain),
    );

    expect(output).toContain(workflow.outcome);
    for (const [index, step] of workflow.steps.entries()) {
      expect(output).toContain(`Step ${index + 1}`);
      expect(output).toContain(step.title);
      expect(output).toContain(step.mode);
      expect(output).not.toContain(step.skill);
    }
    expect(output).toContain("'docsfab' 'run' 'create-documentation'");
    expect(output.replace(/\s+/gu, "")).toContain("'docsfab''run''create-documentation'");
  });

  it("keeps offline simulation scope, every check, and JSON result compatibility", () => {
    const result = runOfflineProductTest();
    const output = normalizeOutput(
      renderCliPresentation(offlineProductTestPresentation(result), plain),
    );
    const quiet = normalizeOutput(
      renderCliPresentation(offlineProductTestPresentation(result, "quiet"), plain),
    );
    const machine = JSON.parse(serializeOfflineProductTest(result)) as {
      schemaVersion: number;
      kind: string;
      status: string;
      steps: readonly { id: string; status: string }[];
    };

    expect(output).toContain("fake provider and GitLab boundaries");
    expect(output).toContain("no real external writes");
    expect(output).toContain("fake external mutation");
    expect(output).toContain("external mutation");
    for (const step of result.steps) {
      expect(output.replace(/\s+/gu, "")).toContain(step.id);
      expect(output).toContain(step.status);
    }
    expect(machine).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-offline-product-test",
      status: "passed",
      steps: result.steps,
    });
    expect(quiet.replace(/\s+/gu, "")).toContain(result.sha256);
    expect(quiet).toContain("no real external writes");
  });
});
