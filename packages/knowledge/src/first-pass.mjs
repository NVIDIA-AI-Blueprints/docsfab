// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * First-pass repository gathering: register inspectable sources from the
 * selected tree, propose behavior claims that quote those sources, and export
 * a candidate knowledge snapshot. Does not interview, invent intent, stamp
 * heading quotes as verified behavior, or approve a shared model.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import { KnowledgeBackend } from "./backend.mjs";
import { resolveSourceEvidence } from "./evidence-source.mjs";
import { knowledgeAcceptedSnapshot } from "./exports.mjs";
import {
  assessOrdinaryDocumentationSupport,
  classifyDocumentationPartialFallback,
  decodeFirstPassRequestIntent,
  DOCUMENTATION_PARTIAL_KIND,
  FIRST_PASS_SUPPORT_KIND,
  FirstPassSupportError,
  // Shared with the gate so the two repository walks exclude the same directories.
  isIgnoredScanDirectory,
  parseOrdinaryDocumentationRequest,
} from "./first-pass-support.mjs";
import { KnowledgeStore } from "./store.mjs";

const ACTOR = "docsfab-first-pass";
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_DOC_FILES = 12;
const MAX_REQUEST_STATEMENTS = 32;
const MAX_STATEMENT_CHARS = 240;
const BOUNDED_BEHAVIOR_REQUEST_PREFIX = "Write `docs/";
const BOUNDED_BEHAVIOR_REQUEST_SUFFIX =
  "` using only these repository-observed behavior claims:";
const BOUNDED_BEHAVIOR_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const BOUNDED_BEHAVIOR_FILE = /^[A-Za-z0-9_-]+\.mdx?$/u;
const INTENT_BEARING_PAGE =
  /\b(about|purpose|vision|mission|audience|rationale|product\s+intent)\b/iu;
const README_NAMES = new Set([
  "readme.md",
  "readme.mdx",
  "readme.rst",
  "readme.txt",
  "readme",
]);

export async function gatherRepositoryFirstPass(input) {
  const repositoryPath = requirePath(input.repositoryPath, "repositoryPath");
  const dataDirectory = requirePath(input.dataDirectory, "dataDirectory");
  const instruction =
    optionalText(input.instruction) ?? "Create source-grounded documentation.";
  const revision = optionalText(input.revision) ?? "HEAD";
  const productName = basename(repositoryPath) || "repository";
  const requested = parseBoundedBehaviorRequest(instruction);
  // With the host's admitted intent the request is ordinary by admission, and
  // its words are not parsed for targets.
  const ordinaryRequest =
    decodeFirstPassRequestIntent(input.requestIntent, instruction) ??
    parseOrdinaryDocumentationRequest({
      instruction,
      revision,
      workflow: input.workflow,
    });
  // The host's match for its own configured credentials (#1807). A credential
  // shape alone never stops gathering; without a host match nothing does.
  const containsCredentialMaterial =
    typeof input.containsCredentialMaterial === "function"
      ? input.containsCredentialMaterial
      : () => false;
  if (ordinaryRequest && containsCredentialMaterial(instruction)) {
    credentialMaterial({ phase: "request", rule: "credential-material", location: "$instruction" });
  }
  const sources = await discoverRepositorySources(repositoryPath, {
    containsCredentialMaterial: ordinaryRequest ? containsCredentialMaterial : undefined,
  });

  const store = new KnowledgeStore(dataDirectory);
  await store.initialize();
  const backend = new KnowledgeBackend(store);
  const dispatch = (name, payload) =>
    backend.dispatch(name, {
      expectedVersion: backend.getState().version,
      actor: ACTOR,
      input: payload,
    });

  await dispatch("project.activate", {
    name: productName,
    productVersion: revision,
    outcome:
      "Establish a repository-grounded candidate model before documentation generation.",
    audience: "Documentation contributors",
    targetTask: instruction,
    authority: {
      requesterEntitlement: "Contribute",
      repositoryGrant: "Observe",
      workflowPolicy: "Contribute",
      backendCapability: "Contribute",
    },
    policy: { localOnly: true, firstPass: true },
  });

  const projectId = Object.keys(backend.getState().projects)[0];
  const sourceIds = [];
  for (const source of sources) {
    const result = await dispatch("source.register", {
      projectId,
      title: source.title,
      kind: source.kind,
      evidenceRole: "behavior",
      location: source.location,
      authority: "repository-revision",
      freshness: "current-revision",
    });
    sourceIds.push(result.event.data.id);
  }

  const claimIds = [];
  for (const [index, source] of sources.entries()) {
    const result = await dispatch("claim.propose", {
      projectId,
      statement: source.statement,
      kind: "behavior",
      scope: productName,
      evidenceIds: [sourceIds[index]],
    });
    claimIds.push(result.event.data.id);
  }
  for (const statement of requested?.statements ?? []) {
    const evidenceIds = sources.flatMap((source, index) =>
      source.substantiveStatements?.includes(statement) ? [sourceIds[index]] : [],
    );
    if (evidenceIds.length === 0) continue;
    const result = await dispatch("claim.propose", {
      projectId,
      statement,
      kind: "behavior",
      scope: productName,
      evidenceIds,
    });
    claimIds.push(result.event.data.id);
  }

  // Optional source-evidence intake. With a binding, every claim quotes the exact
  // retained derivative bytes for a named span, so a citation can be checked
  // against the sealed representation.
  const sourceEvidenceIds = [];
  if (input.sourceEvidence) {
    const resolved = resolveSourceEvidence(input.sourceEvidence);
    for (const source of resolved.sources) {
      const registration = await dispatch("source.register", {
        projectId,
        title: `Source observation ${source.observationId}`,
        kind: "source-evidence",
        evidenceRole: "behavior",
        location: source.location ?? source.representationId,
        authority: source.authority,
        freshness: source.freshness,
      });
      sourceEvidenceIds.push(registration.event.data.id);
      for (const span of source.spans) {
        if (span.text.length === 0 || span.text.length > MAX_STATEMENT_CHARS) continue;
        const claim = await dispatch("claim.propose", {
          projectId,
          statement: `Source span ${span.spanId} states: "${span.text}".`,
          kind: "behavior",
          scope: productName,
          evidenceIds: [registration.event.data.id],
        });
        claimIds.push(claim.event.data.id);
      }
    }
  }

  const model = await dispatch("model.create-version", {
    projectId,
    title: "First-pass repository-observed candidate",
    claimIds,
  });

  const snapshot = knowledgeAcceptedSnapshot(
    backend.getState(),
    projectId,
    model.event.data.id,
    {
      allowCandidate: true,
    },
  );
  let support;
  let authorizationStop;
  try {
    support = await assessOrdinaryDocumentationSupport({
      repositoryPath,
      instruction,
      revision,
      workflow: input.workflow,
      snapshotSha256: snapshot.snapshotSha256,
      modelCall: input.modelCall,
      containsCredentialMaterial,
      // The host's resolved `--source` selections, passed through unchanged; the
      // gate admits them by validated path.
      ...(input.boundSourcePaths ? { boundSourcePaths: input.boundSourcePaths } : {}),
      ...(input.authorizedWriteRoots
        ? { authorizedWriteRoots: input.authorizedWriteRoots }
        : {}),
      ...(input.requestIntent !== undefined ? { requestIntent: input.requestIntent } : {}),
      // The host-sized model budget, including hinted correction rounds.
      ...(input.modelBudget !== undefined ? { modelBudget: input.modelBudget } : {}),
      // The host's resolved firstPass.* acquisition bounds and deadlines, and
      // the selected revision's tracked files, which acquisition lists instead
      // of walking the tree.
      ...(input.firstPassLimits !== undefined ? { firstPassLimits: input.firstPassLimits } : {}),
      ...(input.trackedFiles !== undefined ? { trackedFiles: input.trackedFiles } : {}),
      ...(typeof input.now === "function" ? { now: input.now } : {}),
    });
  } catch (error) {
    if (error instanceof FirstPassSupportError && error.code === "needs-authorization") {
      authorizationStop = { code: error.code, message: error.message };
    } else {
      throw error;
    }
  }
  if (support) {
    await store.writePrivateFile(
      `${FIRST_PASS_SUPPORT_KIND}.json`,
      `${JSON.stringify(support, null, 2)}\n`,
    );
    let classified;
    try {
      classified = classifyDocumentationPartialFallback({
        support,
        instruction,
        repositoryPath,
        ...(input.authorizedWriteRoots
          ? { authorizedWriteRoots: input.authorizedWriteRoots }
          : {}),
      });
    } catch {
      // Classification cannot mint original-request success; gather still retains support.
    }
    if (classified?.originalRequestCompletion === "incomplete") {
      await store.writePrivateFile(
        `${DOCUMENTATION_PARTIAL_KIND}.json`,
        `${JSON.stringify(classified.envelope, null, 2)}\n`,
      );
    }
  }
  return {
    snapshot,
    projectId,
    modelVersionId: model.event.data.id,
    sourceCount: sources.length,
    sourceEvidenceCount: sourceEvidenceIds.length,
    ...(support ? { support } : {}),
    ...(authorizationStop ? { authorizationStop } : {}),
  };
}

async function discoverRepositorySources(repositoryPath, options = {}) {
  const sources = [];
  const readme = await findReadme(repositoryPath, options);
  if (readme) sources.push(readme);
  const docs = await findDocPages(repositoryPath, options, new Set(readme ? [readme.location] : []));
  for (const page of docs) {
    if (sources.length >= MAX_DOC_FILES) break;
    if (sources.some((source) => source.location === page.location)) continue;
    sources.push(page);
  }
  if (sources.length > 0) return sources;
  return [
    {
      title: "Selected repository revision",
      kind: "repository",
      location: ".",
      statement:
        "The selected revision has no README or docs entrypoint; first-pass knowledge is repository identity only.",
    },
  ];
}

async function findReadme(repositoryPath, options) {
  let entries;
  try {
    entries = await readdir(repositoryPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const match = entries
    .filter((entry) => entry.isFile() && README_NAMES.has(entry.name.toLowerCase()))
    .sort((left, right) => readmeRank(left.name) - readmeRank(right.name))[0];
  if (!match) return undefined;
  return readSourceFile(repositoryPath, match.name, "readme", options);
}

async function findDocPages(repositoryPath, options, excludedLocations = new Set()) {
  const pages = [];
  await walkMarkdown(repositoryPath, repositoryPath, pages, options, excludedLocations);
  return pages;
}

async function walkMarkdown(directory, repositoryPath, pages, options, excludedLocations) {
  if (pages.length >= MAX_DOC_FILES) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (pages.length >= MAX_DOC_FILES) return;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name.startsWith(".") ||
        isIgnoredScanDirectory(entry.name, directory === repositoryPath)
      )
        continue;
      await walkMarkdown(absolute, repositoryPath, pages, options, excludedLocations);
      continue;
    }
    if (!entry.isFile() || !/\.mdx?$/iu.test(entry.name)) continue;
    const relativePath = relative(repositoryPath, absolute)
      .split(sep)
      .join("/");
    if (excludedLocations.has(relativePath)) continue;
    const source = await readSourceFile(
      repositoryPath,
      relativePath,
      "document",
      options,
    );
    if (source) pages.push(source);
  }
}

async function readSourceFile(repositoryPath, relativePath, kind, options) {
  if (options?.containsCredentialMaterial?.(relativePath)) {
    credentialMaterial({
      phase: "evidence-acquisition",
      rule: "credential-material",
      location: "$repository",
    });
  }
  const absolute = join(repositoryPath, relativePath);
  let bytes;
  try {
    const metadata = await lstat(absolute);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_SOURCE_BYTES
    ) {
      return undefined;
    }
    bytes = await readFile(absolute, "utf8");
  } catch {
    return undefined;
  }
  if (options?.containsCredentialMaterial?.(bytes)) {
    credentialMaterial({
      phase: "evidence-acquisition",
      rule: "credential-material",
      location: "$repository",
    });
  }
  const heading = firstHeading(bytes) ?? firstLine(bytes);
  const quoted = clip(heading ?? relativePath, MAX_STATEMENT_CHARS - 80);
  return {
    title: relativePath,
    kind,
    location: relativePath,
    statement: `Repository source ${relativePath} states: "${quoted}".`,
    substantiveStatements: /\.mdx?$/iu.test(relativePath)
      ? eligibleMarkdownStatements(bytes)
      : [],
  };
}

function parseBoundedBehaviorRequest(instruction) {
  const text = instruction.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (INTENT_BEARING_PAGE.test(text)) return undefined;
  const [header, ...claimLines] = text.split("\n");
  if (
    !header?.startsWith(BOUNDED_BEHAVIOR_REQUEST_PREFIX) ||
    !header.endsWith(BOUNDED_BEHAVIOR_REQUEST_SUFFIX) ||
    claimLines.length === 0 ||
    claimLines.length > MAX_REQUEST_STATEMENTS ||
    claimLines.some((line) => !line.startsWith("- ") || line.length === 2)
  ) {
    return undefined;
  }
  const relativePath = header.slice(
    BOUNDED_BEHAVIOR_REQUEST_PREFIX.length,
    -BOUNDED_BEHAVIOR_REQUEST_SUFFIX.length,
  );
  const pathParts = relativePath.split("/");
  const file = pathParts.pop();
  if (
    !file ||
    !BOUNDED_BEHAVIOR_FILE.test(file) ||
    pathParts.some((part) => !BOUNDED_BEHAVIOR_PATH_SEGMENT.test(part))
  ) {
    return undefined;
  }
  const statements = claimLines.map((line) => line.slice(2));
  if (
    statements.some(
      (statement) => statement.length === 0 || [...statement].length > MAX_STATEMENT_CHARS,
    ) ||
    new Set(statements).size !== statements.length
  ) {
    return undefined;
  }
  return { statements };
}

function eligibleMarkdownStatements(text) {
  const lines = text.normalize("NFC").replace(/\r\n?/gu, "\n").split("\n");
  if (hasUnsupportedHtml(lines) || lines.some((line) => /^ {0,3}>/u.test(line))) {
    return [];
  }
  const excluded = new Set();
  if (!excludeFrontmatter(lines, excluded) || !excludeFencedCode(lines, excluded)) {
    return [];
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,3}#{1,6}(?:\s|$)/u.test(line) || /^ {0,3}(?:[*_-]\s*){3,}$/u.test(line)) {
      excluded.add(index);
    }
    if (/^ {0,3}(?:=+|-+)\s*$/u.test(line) && index > 0) {
      excluded.add(index - 1);
      excluded.add(index);
    }
    if (/^(?:\t| {4})/u.test(line) || /^ {1,3}(?:[-+*]|\d+[.)])\s/u.test(line)) {
      excluded.add(index);
    }
  }

  const statements = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (excluded.has(index)) continue;
    const line = lines[index];
    const bullet = line.match(/^[-+*] (.+)$/u);
    const previous = lines[index - 1];
    const next = lines[index + 1];
    const previousAllowsList =
      previous === undefined || previous.trim() === "" || /^[-+*] .+$/u.test(previous);
    const nextAllowsList = next === undefined || next.trim() === "" || /^[-+*] .+$/u.test(next);
    if (bullet) {
      const statement = bullet[1].trimEnd();
      if (
        previousAllowsList &&
        nextAllowsList &&
        !/^(?:[-+*]|\d+[.)])\s/u.test(statement) &&
        isBoundedStatement(statement) &&
        !startsUnsupportedMarkdown(statement)
      ) {
        statements.push(statement);
      }
      continue;
    }
    if (
      line === line.trimStart() &&
      (previous === undefined || previous.trim() === "") &&
      (next === undefined || next.trim() === "")
    ) {
      const statement = line.trimEnd();
      if (isBoundedStatement(statement) && !startsUnsupportedMarkdown(statement)) {
        statements.push(statement);
      }
    }
  }
  return [...new Set(statements)];
}

function hasUnsupportedHtml(lines) {
  const text = lines.join("\n");
  return (
    /\x3c!--|-->|\x3c\/?[A-Za-z][^>]*>|\x3c!(?:[A-Z]|\[)|\x3c\?/u.test(text) ||
    lines.some((line) => /\x3c\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/|$)/u.test(line))
  );
}

function excludeFrontmatter(lines, excluded) {
  const first = lines[0]?.replace(/^\uFEFF/u, "");
  if (!/^---\s*$/u.test(first ?? "")) return true;
  for (let index = 0; index < lines.length; index += 1) {
    excluded.add(index);
    if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(lines[index])) return true;
  }
  return false;
}

function excludeFencedCode(lines, excluded) {
  let fence;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!fence) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})[^\n]*$/u);
      if (!opening) continue;
      fence = { marker: opening[1][0], length: opening[1].length };
      excluded.add(index);
      continue;
    }
    excluded.add(index);
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
    if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
      fence = undefined;
    }
  }
  return fence === undefined;
}

function isBoundedStatement(statement) {
  return statement.length > 0 && [...statement].length <= MAX_STATEMENT_CHARS;
}

function startsUnsupportedMarkdown(statement) {
  return (
    statement !== statement.trimStart() ||
    /^(?:#{1,6}\s|>|`{3,}|~{3,}|<|\d+[.)]\s|\[[^\]]+\]:\s|\|)/u.test(statement) ||
    /^(?:[*_-]\s*){3,}$/u.test(statement) ||
    /\|$/u.test(statement)
  );
}

function readmeRank(name) {
  switch (name.toLowerCase()) {
    case "readme.md":
      return 0;
    case "readme.mdx":
      return 1;
    case "readme.rst":
      return 2;
    case "readme.txt":
      return 3;
    case "readme":
      return 4;
    default:
      return 5;
  }
}

function firstHeading(text) {
  const match = text.match(/^#{1,6}\s+(.+)$/mu);
  return match?.[1]?.trim();
}

function firstLine(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("<"));
}

function clip(value, max) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function optionalText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function credentialMaterial(diagnostic) {
  throw new FirstPassSupportError(
    "credential-material",
    "First-pass knowledge rejected credential material before persistence.",
    [],
    diagnostic,
  );
}
