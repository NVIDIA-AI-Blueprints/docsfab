// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalDigest } from "../content-ir/canonical.js";
import { listTemplates, parseTemplateSchema, validateGovernedTemplateBundle } from "./catalog.js";
import type {
  ApprovedTemplatePlan,
  GovernedTemplateBundle,
  TemplateCatalogEntry,
  TemplateEvidenceGap,
  TemplateOutputPreview,
  TemplatePreviewSiteInput,
  TemplatePreviewTopic,
  TemplateRenderSchema,
  TemplateSitePreview,
  TemplateTodo,
  TemplateVariable,
} from "./contracts.js";
import { templateSelectionDigest } from "./selection.js";
import { MAX_TEMPLATE_OUTPUTS } from "./paths.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;

/** Pure preview: validates, renders in memory, and performs no filesystem I/O. */
export function previewSite(value: unknown): TemplateSitePreview {
  const input = parsePreviewInput(value);
  const bundle = validateGovernedTemplateBundle(input.bundle);
  const plan = validateApprovedPlan(input.plan, input.evaluationTime);
  const catalog = listTemplates({ bundle });
  if (catalog.digest !== plan.templateCatalogDigest) {
    throw new Error("Template catalog does not match the approved plan digest.");
  }
  const definitions = new Map(bundle.manifest.templates.map((entry) => [entry.id, entry]));
  const catalogEntries = new Map(catalog.templates.map((entry) => [entry.id, entry]));
  const topics = input.topics.map((topic, index) => validateTopic(topic, index, plan));
  assertUnique(
    topics.map((topic) => topic.id),
    "topic ids",
  );
  assertUnique(
    topics.map((topic) => topic.slug),
    "topic slugs",
  );
  assertUnique(
    topics.map((topic) => topic.outputPath.toLowerCase()),
    "output paths",
  );
  const selectedPaths = topics.map((topic) => topic.outputPath).sort(compareText);
  const approvedPaths = plan.outputs.map((output) => output.path).sort(compareText);
  if (
    selectedPaths.length !== approvedPaths.length ||
    selectedPaths.some((path, index) => path !== approvedPaths[index])
  ) {
    throw new Error("Template selection must exactly match the approved output scope.");
  }
  if (templateSelectionDigest(topics) !== plan.templateSelectionDigest) {
    throw new Error("Template selection does not match the approved plan digest.");
  }

  const outputs = topics
    .map((topic) => {
      const definition = definitions.get(topic.templateId);
      const catalogEntry = catalogEntries.get(topic.templateId);
      if (!definition || !catalogEntry)
        throw new Error(`Unknown template id: ${topic.templateId}.`);
      const schema = parseTemplateSchema(definition.schema.content, definition.format);
      return renderTopic(topic, definition.template.content, schema, catalogEntry);
    })
    .sort((left, right) => compareText(left.path, right.path));
  const preview = {
    schemaVersion: 1 as const,
    plan: {
      planId: plan.planId,
      candidateId: plan.candidateId,
      digest: plan.digest,
      repositoryRevision: plan.repository.revision,
      repositoryContentDigest: plan.repository.contentDigest,
      iaEvaluationDigest: plan.iaEvaluation.digest,
    },
    catalogDigest: catalog.digest,
    outputs,
    writesPerformed: false as const,
  };
  return { ...preview, digest: canonicalDigest(preview) };
}

/** Namespaced primitive surface used by the harness adapter. */
export const template = Object.freeze({ list: listTemplates, previewSite });

function parsePreviewInput(value: unknown): TemplatePreviewSiteInput {
  const root = closedRecord(
    value,
    ["bundle", "plan", "evaluationTime", "topics"],
    "template.previewSite input",
  );
  if (!Array.isArray(root.topics) || root.topics.length === 0)
    throw new Error("template.previewSite topics must be a non-empty array.");
  return {
    bundle: root.bundle as GovernedTemplateBundle,
    plan: root.plan as ApprovedTemplatePlan,
    evaluationTime: timestamp(root.evaluationTime, "evaluationTime"),
    topics: root.topics as TemplatePreviewTopic[],
  };
}

function validateApprovedPlan(value: unknown, evaluationTime: string): ApprovedTemplatePlan {
  const root = closedRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "digest",
      "repository",
      "planId",
      "candidateId",
      "iaEvaluation",
      "templateSelectionDigest",
      "templateCatalogDigest",
      "repositoryCheckPolicy",
      "approval",
      "expiresAt",
      "outputs",
    ],
    "approved template plan",
  );
  if (root.schemaVersion !== 1 || root.kind !== "ia-plan")
    throw new Error("approved template plan identity is invalid.");
  const repository = closedRecord(
    root.repository,
    ["revision", "contentDigest"],
    "approved template plan repository",
  );
  const revision = gitObject(repository.revision, "approved template plan repository revision");
  const contentDigest = hash(
    repository.contentDigest,
    "approved template plan repository contentDigest",
  );
  const evaluation = closedRecord(
    root.iaEvaluation,
    ["kind", "digest", "repositoryRevision", "repositoryContentDigest", "eligible"],
    "approved template plan IA evaluation",
  );
  if (evaluation.kind !== "ia-evaluation" || evaluation.eligible !== true)
    throw new Error("approved template plan requires an eligible IA evaluation.");
  if (
    evaluation.repositoryRevision !== revision ||
    evaluation.repositoryContentDigest !== contentDigest
  ) {
    throw new Error("approved template plan IA evaluation is from another repository revision.");
  }
  const approval = closedRecord(
    root.approval,
    ["status", "requirement", "approvedBy", "approvedAt"],
    "approved template plan approval",
  );
  if (
    approval.status !== "approved" ||
    (approval.requirement !== "maintainer" && approval.requirement !== "product-owner")
  ) {
    throw new Error("template preview requires explicit maintainer or owner approval.");
  }
  const approvedAt = timestamp(approval.approvedAt, "approved template plan approvedAt");
  const expiresAt = timestamp(root.expiresAt, "approved template plan expiresAt");
  if (!(approvedAt < expiresAt) || evaluationTime < approvedAt || evaluationTime >= expiresAt) {
    throw new Error("approved template plan is not effective at evaluationTime.");
  }
  if (
    !Array.isArray(root.outputs) ||
    root.outputs.length === 0 ||
    root.outputs.length > MAX_TEMPLATE_OUTPUTS
  ) {
    throw new Error("approved template plan outputs must be non-empty and bounded.");
  }
  const outputs = root.outputs.map((entry, index) => {
    const output = closedRecord(
      entry,
      ["path", "operation"],
      `approved template plan outputs[${index}]`,
    );
    if (output.operation !== "create")
      throw new Error("template preview supports only approved create outputs.");
    return {
      path: outputPath(output.path, `approved template plan outputs[${index}].path`),
      operation: "create" as const,
    };
  });
  assertUnique(
    outputs.map((output) => output.path.toLowerCase()),
    "approved plan output paths",
  );
  return {
    schemaVersion: 1,
    kind: "ia-plan",
    digest: hash(root.digest, "approved template plan digest"),
    repository: { revision, contentDigest },
    planId: identifier(root.planId, "approved template plan planId"),
    candidateId: identifier(root.candidateId, "approved template plan candidateId"),
    iaEvaluation: {
      kind: "ia-evaluation",
      digest: hash(evaluation.digest, "approved template plan IA evaluation digest"),
      repositoryRevision: revision,
      repositoryContentDigest: contentDigest,
      eligible: true,
    },
    templateSelectionDigest: hash(
      root.templateSelectionDigest,
      "approved template plan selection digest",
    ),
    templateCatalogDigest: hash(root.templateCatalogDigest, "approved template catalog digest"),
    repositoryCheckPolicy: policyBinding(
      root.repositoryCheckPolicy,
      "approved repository check policy",
    ),
    approval: {
      status: "approved",
      requirement: approval.requirement,
      approvedBy: text(approval.approvedBy, "approved template plan approvedBy"),
      approvedAt,
    },
    expiresAt,
    outputs,
  };
}

function policyBinding(
  value: unknown,
  label: string,
): { id: string; version: string; digest: string } {
  const root = closedRecord(value, ["id", "version", "digest"], label);
  return {
    id: identifier(root.id, `${label}.id`),
    version: text(root.version, `${label}.version`),
    digest: hash(root.digest, `${label}.digest`),
  };
}

function validateTopic(
  value: unknown,
  index: number,
  plan: ApprovedTemplatePlan,
): TemplatePreviewTopic {
  const root = closedRecord(
    value,
    [
      "id",
      "slug",
      "title",
      "templateId",
      "outputPath",
      "productName",
      "summary",
      "evidenceNodeIds",
    ],
    `topics[${index}]`,
    ["productName", "summary"],
  );
  const slug = text(root.slug, `topics[${index}].slug`);
  if (!SLUG.test(slug)) throw new Error(`topics[${index}].slug is unsafe or not canonical.`);
  const path = outputPath(root.outputPath, `topics[${index}].outputPath`);
  if (path !== `docs/${slug}.md`) {
    throw new Error(`topics[${index}].outputPath does not match its slug.`);
  }
  if (!plan.outputs.some((output) => output.path === path))
    throw new Error(`Topic output is not approved by the plan: ${path}.`);
  if (!Array.isArray(root.evidenceNodeIds))
    throw new Error(`topics[${index}].evidenceNodeIds must be an array.`);
  const evidenceNodeIds = root.evidenceNodeIds.map((entry, evidenceIndex) =>
    evidenceNodeId(entry, `topics[${index}].evidenceNodeIds[${evidenceIndex}]`),
  );
  assertUnique(evidenceNodeIds, `topics[${index}] evidence node ids`);
  return {
    id: identifier(root.id, `topics[${index}].id`),
    slug,
    title: text(root.title, `topics[${index}].title`),
    templateId: identifier(root.templateId, `topics[${index}].templateId`),
    outputPath: path,
    ...(root.productName === undefined
      ? {}
      : { productName: text(root.productName, `topics[${index}].productName`) }),
    ...(root.summary === undefined
      ? {}
      : { summary: text(root.summary, `topics[${index}].summary`) }),
    evidenceNodeIds,
  };
}

function renderTopic(
  topic: TemplatePreviewTopic,
  source: string,
  schema: TemplateRenderSchema,
  catalog: TemplateCatalogEntry,
): TemplateOutputPreview {
  const evidenceGaps: TemplateEvidenceGap[] = [];
  if (topic.evidenceNodeIds.length < schema.minimumEvidenceNodes) {
    evidenceGaps.push({
      code: "insufficient-node-evidence",
      field: "evidence",
      message: `Expected at least ${schema.minimumEvidenceNodes} evidence node(s); received ${topic.evidenceNodeIds.length}.`,
    });
  }
  if (
    schema.variables.some((entry) => entry.name === "summary" && entry.required) &&
    !topic.summary
  ) {
    evidenceGaps.push({
      code: "missing-required-summary",
      field: "summary",
      message: "The governed template requires an evidence-supported summary.",
    });
  }
  const authenticTemplate = !source.includes("{{");
  if (authenticTemplate && source.includes("[Product Name]") && !topic.productName) {
    evidenceGaps.push({
      code: "missing-product-name",
      field: "productName",
      message:
        "The governed template contains [Product Name], but no evidence-supported product name was supplied.",
    });
  }
  const scaffoldSource = authenticTemplate ? stripAuthorContent(source, catalog.format) : source;
  const groundedSource =
    authenticTemplate && topic.productName
      ? applyProductReplacements(scaffoldSource, topic.productName)
      : scaffoldSource;
  if (authenticTemplate) {
    if (groundedSource.includes("@tpl:")) {
      evidenceGaps.push({
        code: "authoring-instructions-present",
        field: "template",
        message:
          "Governed authoring instructions and examples require maintainer completion before publication.",
      });
    }
    const unresolved = new Set(
      [
        ...groundedSource.matchAll(
          /\[(?:[A-Z][^\]\n]{0,79}|(?:org|repo|registry|image|tag|package(?:-name|_name)?))\](?!\()/gu,
        ),
      ].map((match) => match[0]),
    );
    if (unresolved.size > 0) {
      evidenceGaps.push({
        code: "unresolved-template-placeholder",
        field: "template",
        message: `${unresolved.size} governed template placeholder(s) still require evidence.`,
      });
    }
  }
  const todos = evidenceGaps.map((gap) => ({
    code: gap.code,
    field: gap.field,
    marker: todoMarker(catalog.format, gap),
  }));
  const variables: Record<TemplateVariable, string> = {
    title: topic.title,
    slug: topic.slug,
    productName: topic.productName ?? todoForField(todos, "productName", catalog.format),
    summary: topic.summary ?? todoForField(todos, "summary", catalog.format),
    evidence:
      topic.evidenceNodeIds.length > 0
        ? topic.evidenceNodeIds.map((nodeId) => `- \`${nodeId}\``).join("\n")
        : todoForField(todos, "evidence", catalog.format),
  };
  const content = groundedSource.replace(
    /\{\{([a-zA-Z-]+)\}\}/gu,
    (_match, variable: TemplateVariable) => variables[variable],
  );
  return {
    topicId: topic.id,
    slug: topic.slug,
    path: topic.outputPath,
    format: catalog.format,
    content,
    contentSha256: sha256(content),
    template: catalog.template,
    schema: catalog.schema,
    evidenceNodeIds: [...topic.evidenceNodeIds].sort(compareText),
    evidenceGaps,
    todos,
  };
}

/** Deterministic TypeScript port of tpl-new-page's default author-note stripping. */
function stripAuthorContent(source: string, format: "gfm" | "myst"): string {
  let content = source;
  if (format === "gfm") {
    content = content.replace(/> \*\*Note:\*\* Use this template.*?(?=\n---|\n## |\n# |$)/gsu, "");
    content = content.replace(
      /<details>\s*\n\s*<summary><strong>Format Selection Guide<\/strong><\/summary>.*?<\/details>/gsu,
      "",
    );
  } else {
    content = content.replace(/:::\{admonition\} When to Use This Template.*?:::/gsu, "");
    content = content.replace(/::::\{admonition\} Format Selection Guide.*?::::/gsu, "");
  }
  return `${content.trim().replace(/\n{3,}/gu, "\n\n")}\n`;
}

/** Deterministic TypeScript port of tpl-new-page's product replacements. */
function applyProductReplacements(source: string, productName: string): string {
  const packageName = productName
    .toLowerCase()
    .replaceAll(" ", "-")
    .replaceAll("nvidia-", "")
    .replaceAll("nvidia ", "");
  return source
    .replaceAll("[Product Name]", productName)
    .replaceAll("[product-name]", packageName)
    .replaceAll("[package-name]", packageName)
    .replaceAll("[package_name]", packageName.replaceAll("-", "_"))
    .replaceAll("[Product]", productName);
}

function todoForField(
  todos: TemplateTodo[],
  field: TemplateTodo["field"],
  format: "gfm" | "myst",
): string {
  return (
    todos.find((todo) => todo.field === field)?.marker ??
    (format === "gfm" ? "<!-- TODO -->" : ":::{todo}\nTODO\n:::")
  );
}

function todoMarker(format: "gfm" | "myst", gap: TemplateEvidenceGap): string {
  return format === "gfm"
    ? `<!-- TODO(${gap.code}): ${gap.message} -->`
    : `:::{todo} ${gap.code}\n${gap.message}\n:::`;
}

function outputPath(value: unknown, label: string): string {
  const path = text(value, label);
  if (
    !path.startsWith("docs/") ||
    !path.endsWith(".md") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe docs/*.md path.`);
  }
  return path;
}

function closedRecord(
  value: unknown,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root))
    if (!allowed.includes(key)) throw new Error(`${label} contains unknown field ${key}.`);
  for (const key of allowed)
    if (!optional.includes(key) && !(key in root)) throw new Error(`${label} is missing ${key}.`);
  return root;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate or colliding ${label}.`);
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9]+(?:(?:[.:-])[a-z0-9]+)*$/u.test(result))
    throw new Error(`${label} must be a stable lowercase identifier.`);
  return result;
}

function evidenceNodeId(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9]+(?:(?:[.\/:_-])[a-z0-9]+)*$/u.test(result)) {
    throw new Error(`${label} must be a stable lowercase node identifier.`);
  }
  return result;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256.`);
  return result;
}

function gitObject(value: unknown, label: string): string {
  const result = text(value, label);
  if (!GIT_OBJECT_ID.test(result))
    throw new Error(`${label} must be a full lowercase Git object ID.`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) ||
    new Date(result).toISOString() !== result
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return result;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.normalize("NFC") ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${label} must be normalized non-empty text without controls.`);
  }
  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
