// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tool-free admission-model reply parsing. No provider or Pi imports.
 */

import {
  isRunnableWorkflowName,
  RUNNABLE_WORKFLOW_NAMES,
  type RunnableWorkflowName,
} from "../workflow-registry/catalog.js";

export const ADMISSION_MODEL_SYSTEM_PROMPT =
  "You admit DocsFab documentation workflows. Follow the response instruction exactly. Do not use tools.";

/**
 * The workflows offered to the admission model. Under `--patch-only` or
 * `--draft-mr`, `do` routing offers only the workflows that deliver them.
 */
export interface AdmissionOffer {
  readonly workflows: readonly RunnableWorkflowName[];
  readonly writeIntent: boolean;
}

/** Every runnable catalog workflow: the offer without `--patch-only` or `--draft-mr`. */
export const FULL_ADMISSION_OFFER: AdmissionOffer = Object.freeze({
  workflows: RUNNABLE_WORKFLOW_NAMES,
  writeIntent: false,
});

const WRITE_INTENT_GUIDANCE = `The operator asked for a local patch or a draft merge request, so only workflows that change documentation are offered.
A request to check whether documentation needs a change, and to update it if so, is update-documentation: that workflow can also conclude that no change is needed.
`;

function admissionModelPromptPrefix(offer: AdmissionOffer): string {
  return `Reply with a single JSON object and nothing else.
The object must have exactly one key, "workflow", whose value is one of:
${offer.workflows.map((name) => `- ${name}`).join("\n")}
- abstain

Pick the catalog workflow that matches the operator request.
${offer.writeIntent ? WRITE_INTENT_GUIDANCE : ""}Abstain if the request asks to publish, grant writes, install skills, hand the workflow or skill choice to another tool, router, or MCP, or is not a documentation task.
Do not invent workflow names.

Request:
`;
}

export const ADMISSION_MODEL_USER_PROMPT_PREFIX = admissionModelPromptPrefix(FULL_ADMISSION_OFFER);

export function buildAdmissionModelPrompt(
  request: string,
  offer: AdmissionOffer = FULL_ADMISSION_OFFER,
): string {
  return `${admissionModelPromptPrefix(offer)}${request.trim()}`;
}

/**
 * Parse a tool-free admission reply. Any extra key, unknown workflow, workflow
 * outside the offer, or `abstain` is a miss — the table `needs-input` result stands.
 */
export function parseAdmissionModelResponse(
  text: string,
  offer: AdmissionOffer = FULL_ADMISSION_OFFER,
): string | undefined {
  const value = extractFirstJsonObject(text);
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "workflow") return undefined;
  const workflow = (value as { workflow: unknown }).workflow;
  if (typeof workflow !== "string") return undefined;
  if (workflow === "abstain") return undefined;
  if (!isRunnableWorkflowName(workflow)) return undefined;
  if (!offer.workflows.includes(workflow)) return undefined;
  return workflow;
}

function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
