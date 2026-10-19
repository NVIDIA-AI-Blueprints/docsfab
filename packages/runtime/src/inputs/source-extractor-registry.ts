// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The default source-extractor registry: the single place a shipped host learns
 * which original media types it can turn into a derivative.
 *
 * The media-type allowlist is fixed and extension-driven, with no content
 * sniffing: an unlisted extension is refused, so an adapter is never handed
 * bytes it did not claim.
 */
import { DIFF_SOURCE_MEDIA_TYPE, diffSourceExtractorAdapter } from "./adapters/diff.js";
import { docxSourceExtractorAdapter } from "./adapters/docx.js";
import { htmlSourceExtractorAdapter } from "./adapters/html.js";
import { pdfSourceExtractorAdapter } from "./adapters/pdf.js";
import {
  jsonSourceExtractorAdapter,
  notebookSourceExtractorAdapter,
  textSourceExtractorAdapter,
  yamlSourceExtractorAdapter,
} from "./adapters/structured.js";
import {
  createSourceExtractorRegistry,
  normalizeMediaType,
  type SourceExtractorAdapterV1,
  type SourceExtractorRegistryV1,
} from "./source-extraction.js";

/**
 * Every adapter a shipped host registers; only these are reachable from
 * `docsfab run --source`.
 *
 * A new adapter also needs its extensions in `SOURCE_MEDIA_TYPE_BY_EXTENSION`
 * and its parser dependency pinned in `package.json` and the lockfiles.
 */
export const DEFAULT_SOURCE_EXTRACTOR_ADAPTERS: readonly SourceExtractorAdapterV1[] = Object.freeze(
  [
    htmlSourceExtractorAdapter,
    docxSourceExtractorAdapter,
    pdfSourceExtractorAdapter,
    textSourceExtractorAdapter,
    jsonSourceExtractorAdapter,
    yamlSourceExtractorAdapter,
    notebookSourceExtractorAdapter,
    diffSourceExtractorAdapter,
  ],
);

/**
 * Fixed extension to media-type allowlist. Keys are lowercase extensions
 * without the dot; values are lowercase, parameter-free media types.
 *
 * The extension only picks which adapter is offered the bytes. Each adapter
 * checks the bytes itself, so a `.docx` holding a PDF fails closed.
 */
export const SOURCE_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  diff: DIFF_SOURCE_MEDIA_TYPE,
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  htm: "text/html",
  html: "text/html",
  ipynb: "application/x-ipynb+json",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/mdx",
  patch: DIFF_SOURCE_MEDIA_TYPE,
  pdf: "application/pdf",
  toml: "application/toml",
  ts: "text/x-typescript",
  txt: "text/plain",
  xhtml: "application/xhtml+xml",
  yaml: "application/yaml",
  yml: "application/yaml",
});

/** Duplicate media-type claims fail closed inside `createSourceExtractorRegistry`. */
export function createDefaultSourceExtractorRegistry(): SourceExtractorRegistryV1 {
  return createSourceExtractorRegistry(DEFAULT_SOURCE_EXTRACTOR_ADAPTERS);
}

/**
 * Sorted extensions that map to a media type some registered adapter claims.
 * CLI help and the `unsupported-media-type` remediation render this list
 * rather than restating it, so they cannot go stale.
 */
export function supportedSourceExtensions(
  adapters: readonly SourceExtractorAdapterV1[] = DEFAULT_SOURCE_EXTRACTOR_ADAPTERS,
): readonly string[] {
  const claimed = new Set(
    adapters.flatMap((adapter) => adapter.mediaTypes.map((type) => normalizeMediaType(type))),
  );
  return Object.entries(SOURCE_MEDIA_TYPE_BY_EXTENSION)
    .filter(([, mediaType]) => claimed.has(normalizeMediaType(mediaType)))
    .map(([extension]) => extension)
    .sort();
}

/**
 * Returns `undefined` for an unlisted extension. The caller refuses; it never
 * falls back to sniffing or `text/plain`.
 */
export function classifySourceMediaType(repositoryPath: string): string | undefined {
  const name = repositoryPath.slice(repositoryPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  const mediaType = SOURCE_MEDIA_TYPE_BY_EXTENSION[extension];
  return mediaType === undefined ? undefined : normalizeMediaType(mediaType);
}
