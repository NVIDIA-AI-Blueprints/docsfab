// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Active skill metadata shared by runtime, generators and offline tooling. */
interface CatalogSkillMetadata {
  readonly id: string;
  readonly sourceKind: "documentation-skill" | "knowledge-procedure";
  readonly toolMode: "read-only" | "write";
}
export const CATALOG_SKILL_METADATA = Object.freeze([
  Object.freeze({
    id: "assess-documentation-readiness",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "audit-documentation",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "doc-context-analyzer",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "evaluate-document-quality",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "lint-documentation",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "plan-documentation",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "reconcile-product-behavior",
    sourceKind: "knowledge-procedure",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "repo-bootstrap",
    sourceKind: "documentation-skill",
    toolMode: "write",
  }),
  Object.freeze({
    id: "review-documentation",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "template-scaffold-site",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "test-audience-understanding",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({ id: "tpl-design-ia", sourceKind: "documentation-skill", toolMode: "read-only" }),
  Object.freeze({
    id: "verify-technical-accuracy",
    sourceKind: "documentation-skill",
    toolMode: "read-only",
  }),
  Object.freeze({
    id: "write-documentation",
    sourceKind: "documentation-skill",
    toolMode: "write",
  }),
] as const satisfies readonly CatalogSkillMetadata[]);

export const CATALOG_SKILL_IDS = Object.freeze(CATALOG_SKILL_METADATA.map((entry) => entry.id));
export const CATALOG_WRITE_SKILL_IDS = Object.freeze(
  CATALOG_SKILL_METADATA.filter((entry) => entry.toolMode === "write").map((entry) => entry.id),
);
/** Knowledge procedures retain their own contract instead of a quality-skill sidecar. */
export const CATALOG_INVOCATION_CONTRACT_SKILL_IDS = Object.freeze(
  CATALOG_SKILL_METADATA.filter((entry) => entry.sourceKind === "documentation-skill").map(
    (entry) => entry.id,
  ),
);

/** Canonical provenance is selected by maintained metadata, never a lock field. */
export function catalogSkillSourcePath(id: string): string | undefined {
  const entry: CatalogSkillMetadata | undefined = CATALOG_SKILL_METADATA.find(
    (entry) => entry.id === id,
  );
  if (!entry) return undefined;
  const root =
    entry.sourceKind === "knowledge-procedure" ? "packages/knowledge/skills" : "packages/skills";
  return `${root}/${entry.id}/SKILL.md`;
}
