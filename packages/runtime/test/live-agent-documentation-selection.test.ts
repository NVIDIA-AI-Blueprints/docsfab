// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createDocumentationWorkSelection,
  type DocumentationWorkSelectionV1,
} from "../src/live-agent/documentation-work-selection.js";
import { projectDocumentationWorkCapabilities } from "../src/live-agent/documentation-work-capabilities.js";
import type { LiveAgentCapabilities } from "../src/live-agent/capabilities.js";
import { readCatalogSkillCrateLock, verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import { loadVerifiedInvocationMetadata } from "../src/skills/invocation-metadata.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import type { RunRecordRequestIntentV1 } from "../src/request-intent/interpret-record.js";

describe("live-agent documentation work selection", () => {
  it("keeps the caller's RequestIntent object and the ordered multi-skill choice intact", () => {
    const requestIntent = { callerOwned: true } as unknown as RunRecordRequestIntentV1;
    const selected = createDocumentationWorkSelection(
      {
        kind: "skills",
        requestIntent,
        skillIds: ["review-documentation", "verify-technical-accuracy"],
        basis: "request-semantics",
      },
      {
        skillIds: ["review-documentation", "verify-technical-accuracy"],
        workflowIds: [],
      },
    );

    expect(selected).toMatchObject({
      kind: "skills",
      skillIds: ["review-documentation", "verify-technical-accuracy"],
      basis: "request-semantics",
    });
    expect(selected.requestIntent).toBe(requestIntent);
    expect(Object.isFrozen(selected)).toBe(true);
    if (selected.kind === "skills") expect(Object.isFrozen(selected.skillIds)).toBe(true);
  });

  it("records conversation, clarification, workflow, and saved-result inspection separately", () => {
    const installed = {
      skillIds: ["review-documentation"],
      workflowIds: ["review-documentation" as const],
    };
    const choices: DocumentationWorkSelectionV1[] = [
      { kind: "conversation", requestIntent: null },
      { kind: "clarification", requestIntent: null, question: "Which guide should I review?" },
      {
        kind: "workflow",
        requestIntent: null,
        workflowId: "review-documentation",
        basis: "documentation-specialist-default",
      },
      { kind: "inspect-saved-result", requestIntent: null, runId: "saved-run-42" },
    ];

    for (const choice of choices) {
      expect(createDocumentationWorkSelection(choice, installed)).toMatchObject(choice);
    }
  });

  it("rejects selections outside the installed catalog and malformed read-only choices", () => {
    expect(() =>
      createDocumentationWorkSelection(
        {
          kind: "skills",
          requestIntent: null,
          skillIds: ["review-documentation", "missing-skill"],
          basis: "request-semantics",
        },
        { skillIds: ["review-documentation"], workflowIds: [] },
      ),
    ).toThrow(/not installed/u);
    expect(() =>
      createDocumentationWorkSelection(
        { kind: "clarification", requestIntent: null, question: "  " },
        { skillIds: [], workflowIds: [] },
      ),
    ).toThrow(/must include the question/u);
    expect(() =>
      createDocumentationWorkSelection(
        { kind: "inspect-saved-result", requestIntent: null, runId: " " },
        { skillIds: [], workflowIds: [] },
      ),
    ).toThrow(/identify an existing run/u);
  });

  it("projects descriptions and supported inputs/results from verified catalog files", async () => {
    const definition = getWorkflow("review-documentation");
    const workflowSkillIds = [...new Set(definition.steps.map((step) => step.skill))];
    const lock = await readCatalogSkillCrateLock("skill-crate");
    const skills = await Promise.all(
      workflowSkillIds.map(async (skillId) => {
        const locked = lock.skills.find((entry) => entry.id === skillId);
        if (!locked) throw new Error(`Review workflow fixture has no locked skill ${skillId}.`);
        const verified = await verifyCatalogSkill({
          skillCrateDirectory: "skill-crate",
          skillId: locked.id,
          grantedTools: locked.toolPolicy.granted,
          expectedVersion: locked.version,
          expectedContentSha256: locked.contentSha256,
        });
        const invocation = await loadVerifiedInvocationMetadata(verified);
        return { lock: verified.skill, directory: verified.directory, invocation };
      }),
    );
    const capabilities: LiveAgentCapabilities = {
      skills,
      qualityPack: {} as never,
      workflows: [{ name: definition.name, title: definition.title }],
    };

    const projected = await projectDocumentationWorkCapabilities(capabilities);
    const skill = projected.skills.find(({ skillId }) => skillId === "review-documentation");
    const workflow = projected.workflows.find(
      ({ workflowId }) => workflowId === "review-documentation",
    );

    expect(skill?.description).toContain("clean non-author review");
    expect(skill?.results.length).toBeGreaterThan(0);
    expect(
      skill?.invocationProfiles.map(({ applicationResultKind }) => applicationResultKind),
    ).toContain("review-result");
    expect(workflow?.title).toBe("Comprehensive documentation review");
    expect(workflow?.purpose).toBeTruthy();
  });

  it("fails instead of hiding a workflow whose installed skill metadata is incomplete", async () => {
    const definition = getWorkflow("review-documentation");
    const capabilities: LiveAgentCapabilities = {
      skills: [],
      qualityPack: {} as never,
      workflows: [{ name: definition.name, title: definition.title }],
    };

    await expect(projectDocumentationWorkCapabilities(capabilities)).rejects.toThrow(
      /unavailable installed skills/u,
    );
  });
});
