// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "../records/contracts.js";
import type { WorkflowTaskInput } from "../workflow-contracts/contracts.js";
import type { JsonEvidenceValue } from "../json-evidence.js";

export function formatIaLifecycleResult(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IA lifecycle returned an invalid result.");
  }
  const result = value as Record<string, unknown>;
  const lines = [
    `IA lifecycle: ${String(result.disposition ?? result.packageKind ?? result.kind ?? "completed")}`,
  ];
  for (const [label, key] of [
    ["Package", "packageKind"],
    ["Task", "taskKey"],
    ["Digest", "digest"],
    ["Repository", "repositoryIdentity"],
    ["Revision", "repositoryRevision"],
    ["Expires", "expiresAt"],
    ["Application", "applicationPath"],
  ] as const) {
    const item = result[key];
    if (typeof item === "string") lines.push(`${label}: ${item}`);
  }
  if (typeof result.created === "boolean") {
    lines.push(`State: ${result.created ? "created" : "already-current"}`);
  }
  const packaged = result.package;
  if (packaged && typeof packaged === "object" && !Array.isArray(packaged)) {
    const item = packaged as Record<string, unknown>;
    if (typeof item.digest === "string") lines.push(`Digest: ${item.digest}`);
    if (typeof item.expiresAt === "string") lines.push(`Expires: ${item.expiresAt}`);
  }
  for (const [label, key] of [
    ["Analysis", "analysis"],
    ["Planning", "planning"],
  ] as const) {
    const phase = result[key];
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) continue;
    const item = phase as Record<string, unknown>;
    if (typeof item.runId === "string") lines.push(`${label} run: ${item.runId}`);
    if (typeof item.inputDigest === "string") lines.push(`${label} input: ${item.inputDigest}`);
    if (typeof item.iaPlanDigest === "string") lines.push(`${label} plan: ${item.iaPlanDigest}`);
  }
  if (typeof result.nextCommand === "string") lines.push(`Next: ${result.nextCommand}`);
  return lines.join("\n");
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatIaTaskArguments(task: WorkflowTaskInput | undefined): string {
  if (task?.kind !== "ia-plan") return "";
  if (task.scope === "site") return ` --scope site --mode ${task.mode}`;
  const fragment = task.target?.anchor ? `#${task.target.anchor}` : "";
  return ` --scope ${task.scope} --target ${shellWord(`${task.target!.sourcePath}${fragment}`)}`;
}

export function formatIaPlanContinuation(
  record: Pick<RunRecord, "id" | "artifacts">,
  task: WorkflowTaskInput | undefined,
  repositoryPath: string,
): string[] {
  if (
    !record.artifacts?.some((item) => item.role === "output" && item.reference.kind === "ia-plan")
  )
    return [];
  if (task?.kind === "ia-plan" && task.scope === "site" && task.mode === "create") {
    return [
      "Disposition: needs-approval",
      `Action: approve run ${record.id} with docsfab ia approve for ${shellWord(repositoryPath)} using owner-only reviewer credentials.`,
    ];
  }
  return [
    "Disposition: needs-human-decision",
    "Action: no approval command is available for this non-bootstrap plan.",
  ];
}

export { shellWord };

export type { JsonEvidenceValue };
