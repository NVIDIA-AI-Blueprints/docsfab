// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Pin-A schema beside the closed job-json set. Not a public job manifest. */
export const WORKFLOW_SCHEMA_FILENAME = "workflow.schema.json";

export const publicWorkflowNames = Object.freeze([
  "bootstrap",
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
  "readiness",
  "release-documentation-readiness",
  "audit-documentation",
]);

/**
 * Manifest-backed jobs the host spine dispatches and an operator cannot start.
 * They share the manifest schema and directory but are exempt from the
 * evaluate-prompt hygiene rule, which assumes a public job ends in the sealed
 * quality evaluation.
 */
export const hostedWorkflowNames = Object.freeze([
  "live-agent-turn",
  "reconcile-product-behavior",
  "foundation",
  "foundation-to-patch",
  "ia-analysis",
  "ia-plan",
  "site-bootstrap",
]);

const manifestWorkflowNames = Object.freeze([...publicWorkflowNames, ...hostedWorkflowNames]);

const evaluatePromptRequiredReferences = Object.freeze([
  "evaluation.json",
  "quality-score.json",
  "quality-report.md",
  "The model writes the report narrative",
  "the host writes the validated result summary",
]);
const obsoleteEvaluatePromptReferences = Object.freeze([
  "docsfab-quality-report-v0.1",
  "quality-report.schema.json",
]);
const copiedEvaluateDecisionPolicyPatterns = Object.freeze([
  { label: "hard-gate policy", pattern: /\bhard(?:[\s_-]+)gates?\b/iu },
  {
    label: "insufficient-evidence policy",
    pattern: /\binsufficient(?:[\s_-]+)evidence\b/iu,
  },
]);

export function checkWorkflowBoundaries({
  root: packageRoot = root,
  manifestRoot = join(packageRoot, "workflows"),
  sourceRoot = join(packageRoot, "src"),
} = {}) {
  const obsoleteRoot = join(sourceRoot, "workflows");
  if (existsSync(obsoleteRoot)) {
    throw new Error("Workflow boundary check rejected the obsolete src/workflows directory.");
  }

  const schemaPath = join(manifestRoot, WORKFLOW_SCHEMA_FILENAME);
  if (!existsSync(schemaPath)) {
    throw new Error(
      `Workflow boundary check required ${WORKFLOW_SCHEMA_FILENAME} beside the closed job-json set.`,
    );
  }

  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const schemaNames = schema?.$defs?.workflowName?.enum;
  if (JSON.stringify(schemaNames) !== JSON.stringify([...manifestWorkflowNames])) {
    throw new Error(
      "Workflow boundary check required workflow.schema.json name enum to match the closed manifest workflow set.",
    );
  }

  const jsonFiles = readdirSync(manifestRoot)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const manifestFiles = jsonFiles.filter((entry) => entry !== WORKFLOW_SCHEMA_FILENAME);
  const expectedManifestFiles = manifestWorkflowNames.map((name) => `${name}.json`).sort();
  if (JSON.stringify(manifestFiles) !== JSON.stringify(expectedManifestFiles)) {
    throw new Error(
      `Workflow boundary check expected exactly ${expectedManifestFiles.join(", ")}; found ${manifestFiles.join(", ")}.`,
    );
  }

  for (const name of manifestWorkflowNames) {
    const manifestPath = join(manifestRoot, `${name}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    validateJsonSchema(schema, manifest, `workflows/${name}.json`, schema);
    if (manifest.name !== name) {
      throw new Error(`Workflow boundary check rejected malformed public manifest ${name}.json.`);
    }
    if (manifest.schemaVersion === 3) checkCreateV3ManifestShape(manifest, name);
    else if (manifest.schemaVersion === 2) checkUpdateV2ManifestShape(manifest, name);
    else if (name === "bootstrap") checkBootstrapManifestShape(manifest);
    else if (name === "readiness" || name === "release-documentation-readiness")
      checkReadinessManifestShape(manifest, name);
    else if (name === "audit-documentation") checkTemplateAuditManifestShape(manifest);
    else if (publicWorkflowNames.includes(name)) checkEvaluatePromptHygiene(manifest.steps, name);
    else checkHostedManifestShape(manifest, name);
  }

  const publicDefinitionPattern = new RegExp(
    `:\\s*WorkflowDefinition\\s*=\\s*(?:deepFreeze\\s*\\()?\\s*\\{\\s*name\\s*:\\s*["'](?:${manifestWorkflowNames.join("|")})["']`,
    "u",
  );
  for (const filePath of listTypeScriptFiles(sourceRoot)) {
    const source = readFileSync(filePath, "utf8");
    if (publicDefinitionPattern.test(source)) {
      throw new Error(
        `Workflow boundary check found a public workflow definition outside workflows/*.json: ${relative(packageRoot, filePath)}.`,
      );
    }
  }

  return "Workflow ownership boundaries are clean.";
}

function checkCreateV3ManifestShape(manifest, name) {
  if (name !== "create-documentation") {
    throw new Error(
      "Workflow boundary check permits schema V3 only for create-documentation.json.",
    );
  }
  const prefixIds = validateSegment(manifest.prefix, `${name}.json prefix`);
  if (
    manifest.selection.kind !== "authoring-revision-v1" ||
    manifest.selection.afterStepId !== prefixIds.at(-1)
  ) {
    throw new Error(
      "Workflow boundary check required the V3 authoring selection to follow the final prefix step.",
    );
  }
  const prefixWrites = manifest.prefix.steps.filter((step) => step.mode === "write");
  if (
    prefixWrites.length !== 1 ||
    prefixWrites[0].id !== "write-documentation" ||
    prefixWrites[0].skill !== "write-documentation" ||
    prefixWrites[0].kind !== "inference"
  ) {
    throw new Error(
      "Workflow boundary check required the sole CREATE V3 prefix writer to be write-documentation.",
    );
  }
  const branchIds = manifest.branches.map((branch) => branch.id).sort();
  if (JSON.stringify(branchIds) !== JSON.stringify(["retain", "revise"])) {
    throw new Error(
      "Workflow boundary check required exactly the retain and revise CREATE V3 branches.",
    );
  }
  for (const branch of manifest.branches) {
    const suffixIds = validateSegment(branch, `${name}.json ${branch.id} suffix`);
    const selectedSteps = [...manifest.prefix.steps, ...branch.steps];
    const selectedIds = [...prefixIds, ...suffixIds];
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new Error(
        `Workflow boundary check rejected duplicate step identity in the ${name}.json ${branch.id} selected path.`,
      );
    }
    const suffixWrites = branch.steps.filter((step) => step.mode === "write");
    if (branch.id === "retain" && suffixWrites.length !== 0) {
      throw new Error("Workflow boundary check rejected a write step in the retain V3 suffix.");
    }
    if (
      branch.id === "revise" &&
      (suffixWrites.length !== 1 ||
        suffixWrites[0].id !== "revise-documentation" ||
        suffixWrites[0].skill !== "write-documentation" ||
        suffixWrites[0].kind !== "inference" ||
        branch.steps[0] !== suffixWrites[0])
    ) {
      throw new Error(
        "Workflow boundary check required revise-documentation to be the sole first writer in the revise V3 suffix.",
      );
    }
    checkEvaluatePromptHygiene(selectedSteps, `${name}.json ${branch.id} selected path`);
  }
}

function checkBootstrapManifestShape(manifest) {
  const [step] = manifest.steps;
  if (
    manifest.steps.length !== 1 ||
    step.id !== "bootstrap-guidance" ||
    step.skill !== "repo-bootstrap" ||
    step.kind !== "inference" ||
    step.mode !== "write"
  ) {
    throw new Error(
      "Workflow boundary check required the sole repository-bootstrap guidance writer.",
    );
  }
}

function checkEvaluatePromptHygiene(selectedSteps, pathName) {
  const steps = selectedSteps.filter((step) => step.id === "evaluate-document-quality");
  if (steps.length !== 1 || steps[0]?.skill !== "evaluate-document-quality") {
    throw new Error(
      `Workflow boundary check required one evaluate-document-quality step in ${pathName}.`,
    );
  }
  const prompt = steps[0].prompt;
  for (const reference of evaluatePromptRequiredReferences) {
    if (!prompt.includes(reference)) {
      throw new Error(
        `Workflow boundary check required the ${reference} contract reference in the ${pathName} evaluate prompt.`,
      );
    }
  }
  for (const reference of obsoleteEvaluatePromptReferences) {
    if (prompt.includes(reference)) {
      throw new Error(
        `Workflow boundary check rejected the obsolete ${reference} request in the ${pathName} evaluate prompt.`,
      );
    }
  }
  for (const { label, pattern } of copiedEvaluateDecisionPolicyPatterns) {
    if (pattern.test(prompt)) {
      throw new Error(
        `Workflow boundary check rejected copied ${label} in the ${pathName} evaluate prompt.`,
      );
    }
  }
}

function checkUpdateV2ManifestShape(manifest, name) {
  if (name !== "update-documentation") {
    throw new Error(
      "Workflow boundary check permits schema V2 only for update-documentation.json.",
    );
  }
  const prefixIds = validateSegment(manifest.prefix, `${name}.json prefix`);
  if (manifest.selection.afterStepId !== prefixIds.at(-1)) {
    throw new Error(
      "Workflow boundary check required the V2 selection to follow the final prefix step.",
    );
  }
  const branchIds = manifest.branches.map((branch) => branch.id).sort();
  if (JSON.stringify(branchIds) !== JSON.stringify(["assess-no-change", "author"])) {
    throw new Error(
      "Workflow boundary check required exactly the author and assess-no-change V2 branches.",
    );
  }
  for (const branch of manifest.branches) {
    const suffixIds = validateSegment(branch, `${name}.json ${branch.id} suffix`);
    const selectedSteps = [...manifest.prefix.steps, ...branch.steps];
    const selectedIds = [...prefixIds, ...suffixIds];
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new Error(
        `Workflow boundary check rejected duplicate step identity in the ${name}.json ${branch.id} selected path.`,
      );
    }
    if (branch.id === "author" && !branch.steps.some((step) => step.mode === "write")) {
      throw new Error("Workflow boundary check required a write step in the author V2 suffix.");
    }
    if (branch.id === "assess-no-change" && branch.steps.some((step) => step.mode === "write")) {
      throw new Error("Workflow boundary check rejected a write step in the no-change V2 suffix.");
    }
    checkEvaluatePromptHygiene(selectedSteps, `${name}.json ${branch.id} selected path`);
  }
}

function validateSegment(segment, pathName) {
  const stepIds = segment.steps.map((step) => step.id);
  const policyIds = segment.contextPolicy.steps.map((step) => step.stepId);
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`Workflow boundary check rejected duplicate steps in the ${pathName}.`);
  }
  if (JSON.stringify(policyIds) !== JSON.stringify(stepIds)) {
    throw new Error(
      `Workflow boundary check required context policy entries to match the ${pathName} steps in order.`,
    );
  }
  return stepIds;
}

/** Readiness projects evidence; it does not issue the documentation quality evaluation. */
function checkReadinessManifestShape(manifest, name) {
  const expectedStep =
    name === "readiness" ? "assess-readiness" : "assess-release-documentation-readiness";
  const expectedPlan =
    name === "readiness" ? "source-readiness" : "release-documentation-readiness";
  if (
    manifest.steps.some((step) => step.mode !== "read-only") ||
    !manifest.steps.some(
      (step) =>
        step.id === expectedStep &&
        step.skill === "assess-documentation-readiness" &&
        step.searchPlan === expectedPlan &&
        step.searchMode === "observe",
    )
  ) {
    throw new Error(
      `Workflow boundary check requires ${name} to retain its read-only governed assessment phase.`,
    );
  }
}

/**
 * The template audit has no model step: its one host-operation step is
 * pinned field by field so a model or search step cannot be added silently.
 */
function checkTemplateAuditManifestShape(manifest) {
  const [step] = manifest.steps;
  if (
    manifest.steps.length !== 1 ||
    step.id !== "audit-template-conformance" ||
    step.kind !== "host-operation" ||
    step.mode !== "read-only" ||
    step.skill !== "audit-documentation" ||
    ["operation", "invokes", "searchPlan", "searchMode", "consumes", "consumesEvidence"].some(
      (key) => Object.hasOwn(step, key),
    )
  ) {
    throw new Error(
      "Workflow boundary check requires audit-documentation to be one read-only host-operation template audit step.",
    );
  }
}

/**
 * Hosted manifest shapes are activation-scale, so they are pinned here, not
 * only in tests. The host's tool-policy digest seals the workflow name, step
 * ids, and declared tools, so an added step or search plan fails every hosted
 * job at dispatch. Step mode and kind are not in that digest, so this gate
 * pins them.
 */
function checkHostedManifestShape(manifest, name) {
  // A manifest that runs an installed native executor is pinned field by
  // field, because the manifest, not the model, selects its step. One with no
  // native step falls through to the read-only evaluate rule below.
  const nativeSteps = {
    foundation: {
      id: "inspect-foundation",
      kind: "host-operation",
      operation: "foundation",
      mode: "read-only",
      skill: "doc-context-analyzer",
    },
    // The only manifest allowed to declare `invokes`: its executor runs the
    // named child pipeline in process, so the child's identity is pinned here.
    "foundation-to-patch": {
      id: "compose-foundation-to-patch",
      kind: "host-operation",
      operation: "foundation-to-patch",
      invokes: "create-documentation",
      mode: "write",
      skill: "plan-documentation",
    },
    // The one native job whose step is an inference step: its search plan and
    // observe-only mode are pinned, and declaring no `operation` keeps a
    // model-selected step from naming an executor.
    "ia-analysis": {
      id: "analyze-information-architecture",
      kind: "inference",
      mode: "read-only",
      skill: "tpl-design-ia",
      searchPlan: "information-architecture-discovery",
      searchMode: "observe",
    },
    "ia-plan": {
      id: "plan-information-architecture",
      kind: "host-operation",
      operation: "ia-plan",
      mode: "read-only",
      skill: "tpl-design-ia",
      searchPlan: "information-architecture-discovery",
      searchMode: "observe",
    },
    // A write step whose executor applies an already-signed plan, so
    // `template-scaffold-site` is read-only guidance and the manifest, not the
    // model, names the executor and the step id the write grant may cover.
    "site-bootstrap": {
      id: "apply-site-bootstrap",
      kind: "host-operation",
      operation: "site-bootstrap",
      mode: "write",
      skill: "template-scaffold-site",
    },
  };
  const expected = nativeSteps[name];
  if (expected) {
    const [step] = manifest.steps;
    const keys = [
      "id",
      "kind",
      "operation",
      "invokes",
      "mode",
      "skill",
      "searchPlan",
      "searchMode",
    ];
    if (manifest.steps.length !== 1 || keys.some((key) => step[key] !== expected[key])) {
      throw new Error(`Workflow boundary check rejected the declared native step in ${name}.json.`);
    }
    return;
  }
  if (manifest.steps.length !== 1) {
    throw new Error(
      `Workflow boundary check required exactly one step in the hosted manifest ${name}.json.`,
    );
  }
  const [step] = manifest.steps;
  if (
    name === "reconcile-product-behavior" &&
    (step.id !== "compare-product-behavior" || step.skill !== "reconcile-product-behavior")
  ) {
    throw new Error("Workflow boundary check rejected the semantic comparison step binding.");
  }
  if (step.mode !== "read-only" || step.kind !== "evaluate" || step.searchPlan !== undefined) {
    throw new Error(
      `Workflow boundary check required the ${name}.json step to be a read-only evaluate step with no search plan, because its granted tool set must stay byte-identical to review-documentation's.`,
    );
  }
}

function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

function deref(schema, rootSchema) {
  if (!schema || typeof schema !== "object" || typeof schema.$ref !== "string") {
    return schema;
  }
  const match = /^#\/\$defs\/([^/]+)$/u.exec(schema.$ref);
  if (!match) {
    throw new Error(`Workflow schema $ref is unsupported: ${schema.$ref}.`);
  }
  const resolved = rootSchema.$defs?.[match[1]];
  if (!resolved) {
    throw new Error(`Workflow schema $ref did not resolve: ${schema.$ref}.`);
  }
  return resolved;
}

function validateJsonSchema(schema, value, path, rootSchema) {
  const resolved = deref(schema, rootSchema);
  if (resolved.oneOf !== undefined) {
    let matches = 0;
    let versionError;
    for (const candidate of resolved.oneOf) {
      try {
        validateJsonSchema(candidate, value, path, rootSchema);
        matches += 1;
      } catch (error) {
        // A oneOf candidate is expected to reject values belonging to the other closed version.
        const candidateSchema = deref(candidate, rootSchema);
        if (
          candidateSchema.properties?.schemaVersion?.const !== undefined &&
          candidateSchema.properties.schemaVersion.const === value?.schemaVersion
        ) {
          versionError = error;
        }
      }
    }
    if (matches !== 1) {
      if (matches === 0 && versionError) throw versionError;
      throw new Error(
        `${path} must match exactly one supported runtime workflow manifest version.`,
      );
    }
    return;
  }
  if (resolved.const !== undefined && value !== resolved.const) {
    throw new Error(
      `${path} must equal ${JSON.stringify(resolved.const)} in the runtime workflow manifest.`,
    );
  }
  if (resolved.enum !== undefined && !resolved.enum.includes(value)) {
    throw new Error(
      `${path} must be one of ${resolved.enum.join(", ")} in the runtime workflow manifest.`,
    );
  }
  if (resolved.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object in the runtime workflow manifest.`);
    }
    const properties = resolved.properties ?? {};
    if (resolved.additionalProperties === false) {
      const extras = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
      if (extras.length > 0) {
        throw new Error(
          `${path} contains keys unsupported by the runtime workflow manifest schema: ${extras.join(", ")}.`,
        );
      }
    }
    const missing = (resolved.required ?? []).filter(
      (key) => !Object.prototype.hasOwnProperty.call(value, key),
    );
    if (missing.length > 0) {
      throw new Error(
        `${path} is missing keys required by the runtime workflow manifest schema: ${missing.join(", ")}.`,
      );
    }
    for (const [key, subschema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateJsonSchema(subschema, value[key], `${path}.${key}`, rootSchema);
      }
    }
    return;
  }
  if (resolved.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array in the runtime workflow manifest.`);
    }
    if (resolved.minItems !== undefined && value.length < resolved.minItems) {
      throw new Error(
        `${path} must contain at least ${resolved.minItems} item(s) in the runtime workflow manifest.`,
      );
    }
    if (resolved.maxItems !== undefined && value.length > resolved.maxItems) {
      throw new Error(
        `${path} must contain at most ${resolved.maxItems} item(s) in the runtime workflow manifest.`,
      );
    }
    if (
      resolved.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      throw new Error(
        `${path} must not contain duplicate values in the runtime workflow manifest.`,
      );
    }
    if (resolved.items) {
      for (const [index, item] of value.entries()) {
        validateJsonSchema(resolved.items, item, `${path}[${index}]`, rootSchema);
      }
    }
    return;
  }
  if (resolved.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`${path} must be a string in the runtime workflow manifest.`);
    }
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      throw new Error(`${path} must be a non-empty string in the runtime workflow manifest.`);
    }
    return;
  }
  if (resolved.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`${path} must be a boolean in the runtime workflow manifest.`);
    }
    return;
  }
  if (resolved.type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`${path} must be an integer in the runtime workflow manifest.`);
    }
  }
}

/**
 * True only when this exact file is the process entry point. Both sides are
 * realpath-resolved so a symlinked invocation still runs the check; a throw
 * (argv[1] does not exist) means "not the entry point".
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  console.log(checkWorkflowBoundaries());
}
