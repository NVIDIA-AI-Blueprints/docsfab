// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { deepFreeze } from "../contract-kit/freeze.js";
import { isJsonEvidence, parseJsonEvidence } from "../json-evidence.js";
import {
  QualityPackError,
  readVerifiedQualityPackFiles,
  verifyQualityPackContext,
} from "../quality-pack/manifest.js";
import { buildTemplateBundleFromVerifiedFiles, listTemplates } from "./catalog.js";
import type { GovernedTemplateBundle, TemplateCatalog, TemplateFormat } from "./contracts.js";

export interface TemplateSetCapability {
  readonly catalogDigest: string;
  readonly bundle: Readonly<TemplateCatalog["bundle"]>;
}

export const TEMPLATE_CATALOG_POLICY = Object.freeze({
  id: "docsfab:template-catalog",
  version: "1",
});

const TEMPLATE_SET_PIN_C_PREFIX = "formats/template-set-v1";
const TEMPLATE_SET_REGISTRY = "REGISTRY.json";

/**
 * Pinned identity of the governed template set. Its bytes derive from an
 * internal upstream revision after a codename scrub, so their source is this
 * repository's canonical copy: the sealed REGISTRY.json `homepage` plus `.git`.
 * As for the model-comparison kit, the revision is a content digest rather
 * than a commit: the SHA-256 of the sorted `<sha256>  <path>` file lines.
 * bundleSha256 covers the registry, the derived repository line and that digest.
 */
const TEMPLATE_SET_PROVENANCE = Object.freeze({
  id: "template-set-v1",
  version: "1.0.0",
  license: "Apache-2.0 AND CC-BY-4.0",
  bundleSha256: "ea013c43db06a329e7f025e814d1c02e72db285312b43e00e1d9bea8ae40a3a1",
  source: Object.freeze({
    revision: "97dd73cf5ee17704d05cb64e8ffc6dc871e9670900ab12c092c8a197ee3febfb",
    path: "packages/quality/formats/template-set-v1",
  }),
  /**
   * Seal path included in the pinned bundleSha256. The staged bytes live under
   * generated Pin C at `formats/template-set-v1/`.
   */
  sealLocalPath: "governed-assets/template-set-v1",
});

const templateSetBundles = new WeakMap<TemplateSetCapability, GovernedTemplateBundle>();

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function provenanceManifest(
  repository: string,
  files: ReadonlyArray<{ path: string; sha256: string }>,
): string {
  return [
    `repository ${repository}\n`,
    `revision ${TEMPLATE_SET_PROVENANCE.source.revision}\n`,
    `source-path ${TEMPLATE_SET_PROVENANCE.source.path}\n`,
    `local-path ${TEMPLATE_SET_PROVENANCE.sealLocalPath}\n`,
    `version ${TEMPLATE_SET_PROVENANCE.version}\n`,
    `license ${TEMPLATE_SET_PROVENANCE.license}\n`,
    ...[...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.sha256}  ${file.path}\n`),
  ].join("");
}

function sourceRepository(files: ReadonlyArray<{ path: string; bytes: Buffer }>): string {
  const registry = files.find((entry) => entry.path === TEMPLATE_SET_REGISTRY)?.bytes;
  const parsed = registry && isJsonEvidence(registry) ? parseJsonEvidence(registry) : undefined;
  const homepage =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.homepage : undefined;
  // Refuses only a registry that is absent, not strict JSON, or has no string
  // homepage; any other repository it names is left to the bundle seal.
  if (typeof homepage !== "string") {
    // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
    throw new QualityPackError(
      "checksum-mismatch",
      "Template set REGISTRY.json does not name its source homepage.",
    );
  }
  return `${homepage}.git`;
}

function bundleRelativePath(stagedPath: string): string {
  if (stagedPath === TEMPLATE_SET_PIN_C_PREFIX) {
    // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
    throw new QualityPackError("unsafe-path");
  }
  if (!stagedPath.startsWith(`${TEMPLATE_SET_PIN_C_PREFIX}/`)) {
    // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
    throw new QualityPackError("unsafe-path");
  }
  return stagedPath.slice(`${TEMPLATE_SET_PIN_C_PREFIX}/`.length);
}

/** Verify and load only the exact bytes consumed by DocsFab's TypeScript adapter. */
export async function loadTemplateSet(
  projectRoot: string,
  formats: readonly TemplateFormat[] = ["gfm", "myst"],
): Promise<GovernedTemplateBundle> {
  const verifiedPack = await verifyQualityPackContext({
    qualityPackDirectory: resolve(projectRoot, "quality-pack"),
    qualityDirectory: resolve(projectRoot, "quality"),
    skillCrateDirectory: resolve(projectRoot, "skill-crate"),
  });
  const staged = await readVerifiedQualityPackFiles(verifiedPack, TEMPLATE_SET_PIN_C_PREFIX);
  const files = staged.map((entry) => ({
    path: bundleRelativePath(entry.path),
    sha256: entry.sha256,
    bytes: entry.bytes,
  }));
  const repository = sourceRepository(files);
  if (sha256(provenanceManifest(repository, files)) !== TEMPLATE_SET_PROVENANCE.bundleSha256) {
    // hygiene: envelope — QualityPackError maps the stable code through ERROR_MESSAGES.
    throw new QualityPackError("checksum-mismatch");
  }
  const evidence = {
    id: TEMPLATE_SET_PROVENANCE.id,
    version: TEMPLATE_SET_PROVENANCE.version,
    license: TEMPLATE_SET_PROVENANCE.license,
    bundleSha256: TEMPLATE_SET_PROVENANCE.bundleSha256,
    source: { repository, ...TEMPLATE_SET_PROVENANCE.source },
    files: files.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
  };
  const consumed = files.filter(
    (entry) =>
      (entry.path.startsWith("tpl-new-page/assets/templates/") && entry.path.endsWith(".md")) ||
      (entry.path.startsWith("tpl-lint/assets/schemas/") && entry.path.endsWith(".yaml")),
  );
  const injected = Object.fromEntries(
    consumed.map((entry) => [entry.path, entry.bytes.toString("utf8")]),
  );
  return buildTemplateBundleFromVerifiedFiles({
    evidence,
    files: injected,
    formats: [...formats],
  });
}

/**
 * Verify the governed template set and return only an opaque, content-free
 * capability. Template and schema bytes remain private until a trusted
 * operation resolves the exact capability object in this module.
 */
export async function prepareTemplateSet(projectRoot: string): Promise<TemplateSetCapability> {
  const bundle = deepFreeze(await loadTemplateSet(projectRoot));
  const catalog = listTemplates({ bundle });
  const capability = Object.freeze({
    catalogDigest: catalog.digest,
    bundle: Object.freeze({ ...catalog.bundle }),
  });
  templateSetBundles.set(capability, bundle);
  return capability;
}

/** Resolve only capabilities issued by `prepareTemplateSet`. */
export function resolveTemplateSet(capability: unknown): GovernedTemplateBundle {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw new Error("The template set capability is not governed by this module.");
  }
  const bundle = templateSetBundles.get(capability as TemplateSetCapability);
  if (!bundle) {
    throw new Error("The template set capability is not governed by this module.");
  }
  if (listTemplates({ bundle }).digest !== (capability as TemplateSetCapability).catalogDigest) {
    throw new Error("The template set capability catalog changed after it was issued.");
  }
  return bundle;
}
