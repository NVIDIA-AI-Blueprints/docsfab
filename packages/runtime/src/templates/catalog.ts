// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { posix } from "node:path";

import { canonicalDigest } from "../content-ir/canonical.js";
import {
  TEMPLATE_FORMATS,
  TEMPLATE_VARIABLES,
  type GovernedBundleEvidence,
  type GovernedTemplateBundle,
  type GovernedTemplateDefinition,
  type TemplateCatalog,
  type TemplateCatalogEntry,
  type TemplateFileProvenance,
  type TemplateFormat,
  type TemplateListInput,
  type TemplateRenderSchema,
  type VerifiedTemplateFilesInput,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const GENERIC_TEMPLATE_NAMES = new Set([
  "document.md",
  "generic.md",
  "index.md",
  "page.md",
  "readme.md",
  "template.md",
]);

export function listTemplates(value: unknown): TemplateCatalog {
  const input = parseListInput(value);
  const bundle = validateGovernedTemplateBundle(input.bundle);
  const templates = bundle.manifest.templates
    .filter((entry) => input.format === undefined || entry.format === input.format)
    .map((entry) => catalogEntry(bundle.evidence, entry))
    .sort(
      (left, right) => compareText(left.id, right.id) || compareText(left.version, right.version),
    );
  const catalog = {
    schemaVersion: 1 as const,
    bundle: {
      id: bundle.evidence.id,
      version: bundle.evidence.version,
      license: bundle.evidence.license,
      bundleSha256: bundle.evidence.bundleSha256,
      sourceRepository: bundle.evidence.source.repository,
      sourceRevision: bundle.evidence.source.revision,
      sourcePath: bundle.evidence.source.path,
    },
    templates,
  };
  return { ...catalog, digest: canonicalDigest(catalog) };
}

export function validateGovernedTemplateBundle(value: unknown): GovernedTemplateBundle {
  const root = closedRecord(value, ["evidence", "manifest"], "governed template bundle");
  const evidence = parseEvidence(root.evidence);
  const manifestValue = closedRecord(
    root.manifest,
    ["schemaVersion", "templates"],
    "template manifest",
  );
  if (manifestValue.schemaVersion !== 1)
    throw new Error("template manifest schemaVersion must be 1.");
  if (!Array.isArray(manifestValue.templates) || manifestValue.templates.length === 0) {
    throw new Error("template manifest templates must be a non-empty array.");
  }
  const templates = manifestValue.templates.map((entry, index) =>
    parseTemplate(entry, index, evidence),
  );
  if (new Set(templates.map((entry) => entry.id)).size !== templates.length) {
    throw new Error("template manifest contains duplicate template ids.");
  }
  const templatePaths = templates.map((entry) => entry.template.path);
  if (new Set(templatePaths).size !== templatePaths.length) {
    throw new Error("template manifest reuses a template path.");
  }
  return { evidence, manifest: { schemaVersion: 1, templates } };
}

/**
 * Adapts the verified Pin C template set layout without executing
 * its scripts. Every consumed byte must match a file in governed bundle evidence.
 */
export function buildTemplateBundleFromVerifiedFiles(value: unknown): GovernedTemplateBundle {
  const root = closedRecord(value, ["evidence", "files", "formats"], "verified template files", [
    "formats",
  ]);
  const evidence = parseEvidence(root.evidence);
  if (!root.files || typeof root.files !== "object" || Array.isArray(root.files)) {
    throw new Error("verified template file bytes must be an object.");
  }
  const filesValue = closedRecord(
    root.files,
    Object.keys(root.files),
    "verified template file bytes",
  );
  const formats = root.formats === undefined ? [...TEMPLATE_FORMATS] : parseFormats(root.formats);
  const evidenceFiles = new Map(evidence.files.map((entry) => [entry.path, entry]));
  for (const [path, content] of Object.entries(filesValue)) {
    const locked = evidenceFiles.get(safePath(path, `verified file ${path}`));
    if (!locked) throw new Error(`Injected template file is not in governed evidence: ${path}.`);
    if (typeof content !== "string" || sha256(content) !== locked.sha256) {
      throw new Error(`Injected template file does not match governed evidence: ${path}.`);
    }
  }

  const schemaEvidence = evidence.files.filter(
    (entry) => entry.path.startsWith("tpl-lint/assets/schemas/") && entry.path.endsWith(".yaml"),
  );
  const schemaByName = new Map(
    schemaEvidence.map((entry) => [posix.basename(entry.path, ".yaml"), entry]),
  );
  const definitions: GovernedTemplateDefinition[] = [];
  for (const templateFile of evidence.files) {
    const descriptor = upstreamTemplateDescriptor(templateFile.path);
    if (!descriptor || !formats.includes(descriptor.format)) continue;
    const schemaName = upstreamSchemaName(descriptor.name);
    const schemaFile = schemaByName.get(schemaName);
    if (!schemaFile) continue;
    const templateContent = filesValue[templateFile.path];
    const schemaContent = filesValue[schemaFile.path];
    if (typeof templateContent !== "string") {
      throw new Error(`Missing injected verified template bytes: ${templateFile.path}.`);
    }
    if (typeof schemaContent !== "string") {
      throw new Error(`Missing injected verified schema bytes: ${schemaFile.path}.`);
    }
    const schemaMetadata = parseUpstreamYamlSchema(schemaContent);
    if (schemaMetadata.name !== schemaName) {
      throw new Error(`Upstream schema name does not match ${schemaFile.path}.`);
    }
    if (posix.basename(schemaMetadata.sourceTemplate, ".md") !== descriptor.name) continue;
    definitions.push({
      id: `${descriptor.name}-${descriptor.format}`,
      version: evidence.version,
      format: descriptor.format,
      template: { path: templateFile.path, sha256: templateFile.sha256, content: templateContent },
      schema: {
        path: schemaFile.path,
        version: schemaMetadata.schemaVersion,
        sha256: schemaFile.sha256,
        content: schemaContent,
      },
    });
  }
  if (definitions.length === 0)
    throw new Error("Verified template files contain no supported GFM/MyST template-schema pairs.");
  return validateGovernedTemplateBundle({
    evidence,
    manifest: { schemaVersion: 1, templates: definitions },
  });
}

export function parseTemplateSchema(
  content: string,
  expectedFormat: TemplateFormat,
): TemplateRenderSchema {
  if (!content.trimStart().startsWith("{")) {
    parseUpstreamYamlSchema(content);
    return {
      schemaVersion: 1,
      format: expectedFormat,
      variables: TEMPLATE_VARIABLES.map((name) => ({ name, required: false })),
      minimumEvidenceNodes: 0,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("template schema content must be valid JSON.");
  }
  const root = closedRecord(
    parsed,
    ["schemaVersion", "format", "variables", "minimumEvidenceNodes"],
    "template schema",
  );
  if (root.schemaVersion !== 1) throw new Error("template schema schemaVersion must be 1.");
  const format = templateFormat(root.format, "template schema format");
  if (format !== expectedFormat)
    throw new Error("template schema format does not match its template.");
  if (!Array.isArray(root.variables))
    throw new Error("template schema variables must be an array.");
  const variables = root.variables.map((entry, index) => {
    const variable = closedRecord(
      entry,
      ["name", "required"],
      `template schema variables[${index}]`,
    );
    if (typeof variable.name !== "string" || !TEMPLATE_VARIABLES.includes(variable.name as never)) {
      throw new Error(`template schema variables[${index}].name is unsupported.`);
    }
    if (typeof variable.required !== "boolean") {
      throw new Error(`template schema variables[${index}].required must be boolean.`);
    }
    return {
      name: variable.name as TemplateRenderSchema["variables"][number]["name"],
      required: variable.required,
    };
  });
  if (new Set(variables.map((entry) => entry.name)).size !== variables.length) {
    throw new Error("template schema contains duplicate variables.");
  }
  for (const required of ["title", "slug"] as const) {
    if (!variables.some((entry) => entry.name === required && entry.required)) {
      throw new Error(`template schema must require ${required}.`);
    }
  }
  if (
    !Number.isSafeInteger(root.minimumEvidenceNodes) ||
    (root.minimumEvidenceNodes as number) < 0
  ) {
    throw new Error("template schema minimumEvidenceNodes must be a non-negative integer.");
  }
  return {
    schemaVersion: 1,
    format,
    variables,
    minimumEvidenceNodes: root.minimumEvidenceNodes as number,
  };
}

function parseListInput(value: unknown): TemplateListInput {
  const input = closedRecord(value, ["bundle", "format"], "template.list input", ["format"]);
  return {
    bundle: input.bundle as GovernedTemplateBundle,
    ...(input.format === undefined
      ? {}
      : { format: templateFormat(input.format, "template.list format") }),
  };
}

function parseEvidence(value: unknown): GovernedBundleEvidence {
  const root = closedRecord(
    value,
    ["id", "version", "license", "bundleSha256", "source", "files"],
    "bundle evidence",
  );
  const source = closedRecord(
    root.source,
    ["repository", "revision", "path"],
    "bundle evidence source",
  );
  const repository = text(source.repository, "bundle evidence source repository");
  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(repository);
  } catch {
    throw new Error("bundle source repository must be HTTPS without credentials.");
  }
  if (
    repositoryUrl.protocol !== "https:" ||
    repositoryUrl.username ||
    repositoryUrl.password ||
    repositoryUrl.search ||
    repositoryUrl.hash
  ) {
    throw new Error("bundle source repository must be HTTPS without credentials.");
  }
  const revision = text(source.revision, "bundle evidence source revision");
  if (!GIT_OBJECT_ID.test(revision))
    throw new Error("bundle source revision must be a full lowercase Git object ID.");
  if (!Array.isArray(root.files) || root.files.length === 0)
    throw new Error("bundle evidence files must be a non-empty array.");
  const files = root.files.map((entry, index) => {
    const file = closedRecord(entry, ["path", "sha256"], `bundle evidence files[${index}]`);
    return {
      path: safePath(file.path, `bundle evidence files[${index}].path`),
      sha256: hash(file.sha256, `bundle evidence files[${index}].sha256`),
    };
  });
  if (new Set(files.map((entry) => entry.path)).size !== files.length)
    throw new Error("bundle evidence contains duplicate file paths.");
  return {
    id: text(root.id, "bundle evidence id"),
    version: text(root.version, "bundle evidence version"),
    license: text(root.license, "bundle evidence license"),
    bundleSha256: hash(root.bundleSha256, "bundle evidence bundleSha256"),
    source: { repository, revision, path: safePath(source.path, "bundle evidence source path") },
    files,
  };
}

function parseTemplate(
  value: unknown,
  index: number,
  evidence: GovernedBundleEvidence,
): GovernedTemplateDefinition {
  const root = closedRecord(
    value,
    ["id", "version", "format", "template", "schema"],
    `templates[${index}]`,
  );
  const id = identifier(root.id, `templates[${index}].id`);
  const version = text(root.version, `templates[${index}].version`);
  const format = templateFormat(root.format, `templates[${index}].format`);
  const template = parseFile(root.template, `templates[${index}].template`, evidence);
  const schema = parseFile(root.schema, `templates[${index}].schema`, evidence, true);
  if (isGenericTemplateFilename(template.path)) {
    throw new Error(`Template ${id} uses a generic template filename.`);
  }
  if (
    !template.path.endsWith(".md") ||
    (!schema.path.endsWith(".json") && !schema.path.endsWith(".yaml"))
  ) {
    throw new Error(`Template ${id} must use a Markdown template and JSON/YAML schema path.`);
  }
  const parsedSchema = parseTemplateSchema(schema.content, format);
  const tokens = [...template.content.matchAll(/\{\{([a-z-]+)\}\}/gu)].map((match) => match[1]!);
  const malformedTokens = template.content.match(/\{\{[^{}]*\}\}/gu) ?? [];
  if (
    malformedTokens.length !== tokens.length ||
    tokens.some((token) => !TEMPLATE_VARIABLES.includes(token as never))
  ) {
    throw new Error(`Template ${id} contains an unsupported placeholder.`);
  }
  if (schema.content.trimStart().startsWith("{")) {
    for (const variable of parsedSchema.variables.filter((entry) => entry.required)) {
      if (!tokens.includes(variable.name))
        throw new Error(`Template ${id} omits required placeholder ${variable.name}.`);
    }
  }
  return {
    id,
    version,
    format,
    template,
    schema: {
      ...schema,
      version: text(
        (root.schema as Record<string, unknown>).version,
        `templates[${index}].schema.version`,
      ),
    },
  };
}

function parseFile(
  value: unknown,
  label: string,
  evidence: GovernedBundleEvidence,
  withVersion = false,
): { path: string; sha256: string; content: string; version?: string } {
  const keys = withVersion
    ? ["path", "version", "sha256", "content"]
    : ["path", "sha256", "content"];
  const root = closedRecord(value, keys, label);
  const path = safePath(root.path, `${label}.path`);
  const expectedHash = hash(root.sha256, `${label}.sha256`);
  const content =
    typeof root.content === "string"
      ? root.content
      : (() => {
          throw new Error(`${label}.content must be a string.`);
        })();
  const actualHash = sha256(content);
  if (actualHash !== expectedHash) throw new Error(`${label} content does not match its SHA-256.`);
  const locked = evidence.files.find((entry) => entry.path === path);
  if (!locked || locked.sha256 !== expectedHash)
    throw new Error(`${label} is not bound to verified bundle evidence.`);
  return {
    path,
    sha256: expectedHash,
    content,
    ...(withVersion ? { version: text(root.version, `${label}.version`) } : {}),
  };
}

function parseFormats(value: unknown): TemplateFormat[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("verified template formats must be non-empty.");
  const formats = value.map((entry, index) =>
    templateFormat(entry, `verified template formats[${index}]`),
  );
  if (new Set(formats).size !== formats.length)
    throw new Error("verified template formats contain duplicates.");
  return formats;
}

function upstreamTemplateDescriptor(
  path: string,
): { name: string; format: TemplateFormat } | undefined {
  const prefix = "tpl-new-page/assets/templates/";
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return undefined;
  const basename = posix.basename(path);
  if (basename.endsWith("-gfm.md")) {
    return { name: basename.slice(0, -"-gfm.md".length), format: "gfm" };
  }
  return { name: basename.slice(0, -".md".length), format: "myst" };
}

function upstreamSchemaName(templateName: string): string {
  return (
    (
      {
        "architecture-overview": "architecture",
        "beginner-tutorial": "tutorial",
        "key-features": "features",
        "single-procedural": "procedural",
      } as Record<string, string>
    )[templateName] ?? templateName
  );
}

function parseUpstreamYamlSchema(content: string): {
  schemaVersion: string;
  libraryVersion: string;
  name: string;
  sourceTemplate: string;
} {
  const field = (name: string): string => {
    const match = content.match(new RegExp(`^${name}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "mu"));
    if (!match?.[1]) throw new Error(`Upstream YAML schema is missing ${name}.`);
    return match[1].trim();
  };
  const schemaVersion = field("schema_version");
  const libraryVersion = field("library_version");
  const name = identifier(field("name"), "upstream YAML schema name");
  const sourceTemplate = safePath(field("source_template"), "upstream YAML schema source_template");
  if (!/^\d+\.\d+$/u.test(schemaVersion))
    throw new Error("Upstream YAML schema_version is unsupported.");
  return { schemaVersion, libraryVersion, name, sourceTemplate };
}

function catalogEntry(
  evidence: GovernedBundleEvidence,
  definition: GovernedTemplateDefinition,
): TemplateCatalogEntry {
  return {
    id: definition.id,
    version: definition.version,
    format: definition.format,
    template: provenance(
      evidence,
      definition.template.path,
      definition.version,
      definition.template.sha256,
    ),
    schema: provenance(
      evidence,
      definition.schema.path,
      definition.schema.version,
      definition.schema.sha256,
    ),
  };
}

function provenance(
  evidence: GovernedBundleEvidence,
  path: string,
  version: string,
  sha256: string,
): TemplateFileProvenance {
  return {
    sourceRepository: evidence.source.repository,
    sourceRevision: evidence.source.revision,
    sourcePath: posix.join(evidence.source.path, path),
    version,
    license: evidence.license,
    sha256,
  };
}

function isGenericTemplateFilename(path: string): boolean {
  const basename = posix.basename(path).toLowerCase();
  if (GENERIC_TEMPLATE_NAMES.has(basename)) return true;
  const stem = basename.replace(/\.md$/u, "").replace(/\.(?:gfm|myst)$/u, "");
  return new Set(["document", "generic", "index", "page", "readme", "template"]).has(stem);
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

function templateFormat(value: unknown, label: string): TemplateFormat {
  if (typeof value !== "string" || !TEMPLATE_FORMATS.includes(value as never))
    throw new Error(`${label} is unsupported.`);
  return value as TemplateFormat;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(result))
    throw new Error(`${label} must be a stable lowercase identifier.`);
  return result;
}

function safePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return path;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256.`);
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
