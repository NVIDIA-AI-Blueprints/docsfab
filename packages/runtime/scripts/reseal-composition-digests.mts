#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-seal the composition digest chain after a deliberate record edit.
 *
 * Use: edit a record in `composition-registry.json` by hand (for example set
 * `status: "retired"` and add its `retirement` block), then run this. It
 * recomputes, in dependency order, every digest that the edit invalidated:
 * each `compositionSha256`, the composition `registrySha256`, each candidate's
 * copy of its composition digest and `candidateSha256`, the projection
 * `registrySha256`, the manifest's file and contract digests, the
 * `installedManifestSha256`, and the compiled installed-manifest pin data.
 *
 * Substitution is textual, never a JSON round-trip: asset digests are taken
 * over file bytes, so re-serialising would reformat every file. Parsing only
 * computes digests; writing replaces exact 64-hex substrings.
 *
 * Run `verify-composition-digests.mts` before editing (it proves the digest
 * rule reproduces the committed digests) and after this script (it proves the
 * chain is consistent). A self-consistent chain cannot catch an author
 * sealing a wrong value.
 *
 * Provider/profile/composition values remain unchanged. The explicit semantic
 * workflow entry is derived from its canonical manifest before sealing. The
 * script refuses to run when the manifest's asset set or the
 * composition/candidate pairing is not what it expects.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  recordedAnswerSubmissionGaps,
  recordedAnswerSubmissionRecordsEvidenceGaps,
} from "../src/model-composition/answer-submission-record.js";

const RUNTIME = resolve(import.meta.dirname, "..");
/** `--root DIR` and `--installed-ts FILE` reseal a copy; tests use them. */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const ROOT = resolve(argument("--root") ?? resolve(RUNTIME, "model-compositions"));
const paths = {
  adapters: resolve(ROOT, "adapter-registry.json"),
  projections: resolve(ROOT, "candidate-projections.json"),
  compositions: resolve(ROOT, "composition-registry.json"),
  manifest: resolve(ROOT, "installed-manifest.json"),
  workflowCatalog: resolve(ROOT, "workflow-catalog.json"),
  installedTs: resolve(
    argument("--installed-ts") ?? resolve(RUNTIME, "src/model-composition/installed-manifest-pin.js"),
  ),
};

// A recorded answer submission must carry every capability field, including
// the probe's `objectMembers`; refuse before anything is written.
{
  const gaps = recordedAnswerSubmissionGaps(
    JSON.parse(await readFile(paths.compositions, "utf8")),
  );
  const recordsEvidenceGaps = await recordedAnswerSubmissionRecordsEvidenceGaps(
    JSON.parse(await readFile(paths.compositions, "utf8")),
    resolve(
      argument("--evidence-root") ??
        resolve(RUNTIME, "docs/internal/evidence/answer-record-corpus-2026-10"),
    ),
  );
  if (gaps.length > 0 || recordsEvidenceGaps.length > 0) {
    for (const gap of gaps) console.error(`  REFUSED ${gap}`);
    for (const gap of recordsEvidenceGaps) console.error(`  REFUSED ${gap}`);
    throw new Error(
      `recorded answer-submission evidence is incomplete in ${gaps.length + recordsEvidenceGaps.length} place(s); retain and bind the qualification evidence before resealing`,
    );
  }
}

const fileSha = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function withoutKey(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = body;
  return rest;
}

/** Replace every occurrence of an exact 64-hex digest. Unique by construction. */
function swapDigest(text: string, from: string, to: string): string {
  if (from === to) return text;
  if (!text.includes(from)) throw new Error(`digest ${from} not present for substitution`);
  return text.split(from).join(to);
}

const changed: string[] = [];

// ---------------------------------------------------------------- adapters
// An adapter record (for example a new pinned native CLI version) moves the
// adapter registry's own digest. Compositions bind adapters by id and version,
// not by digest, so this pass only reseals the registry and its manifest entry.
let adaptersText = await readFile(paths.adapters, "utf8");
{
  const parsed = JSON.parse(adaptersText);
  const nextRegistry = canonicalDigest(withoutKey(parsed, "registrySha256"));
  if (nextRegistry !== parsed.registrySha256) {
    changed.push("adapter registry");
    adaptersText = swapDigest(adaptersText, parsed.registrySha256, nextRegistry);
  }
}
await writeFile(paths.adapters, adaptersText);
const adapterRegistrySha256 = JSON.parse(adaptersText).registrySha256;

// ---------------------------------------------------------------- compositions
let compositionsText = await readFile(paths.compositions, "utf8");
{
  const parsed = JSON.parse(compositionsText);
  for (const composition of parsed.compositions) {
    const next = canonicalDigest(withoutKey(composition, "compositionSha256"));
    if (next !== composition.compositionSha256) {
      changed.push(`composition ${composition.compositionId}`);
      compositionsText = swapDigest(compositionsText, composition.compositionSha256, next);
    }
  }
  const reparsed = JSON.parse(compositionsText);
  const nextRegistry = canonicalDigest(withoutKey(reparsed, "registrySha256"));
  if (nextRegistry !== reparsed.registrySha256) {
    changed.push("composition registry");
    compositionsText = swapDigest(compositionsText, reparsed.registrySha256, nextRegistry);
  }
}
await writeFile(paths.compositions, compositionsText);
const compositionRegistrySha256 = JSON.parse(compositionsText).registrySha256;
const compositionDigestById = new Map<string, string>(
  JSON.parse(compositionsText).compositions.map(
    (c: { compositionId: string; compositionSha256: string }) => [c.compositionId, c.compositionSha256],
  ),
);

// ----------------------------------------------------------------- projections
let projectionsText = await readFile(paths.projections, "utf8");
{
  // A candidate embeds the digest of the composition it projects onto, so the
  // composition pass above must land first or these would reference the old one.
  const parsed = JSON.parse(projectionsText);
  for (const candidate of parsed.candidates) {
    const compositionSha256 = compositionDigestById.get(candidate.compositionId);
    if (!compositionSha256) throw new Error(`no composition for ${candidate.compositionId}`);
    if (candidate.compositionSha256 !== compositionSha256) {
      changed.push(`candidate ${candidate.candidateId} composition reference`);
      projectionsText = swapDigest(projectionsText, candidate.compositionSha256, compositionSha256);
    }
  }
  for (const candidate of JSON.parse(projectionsText).candidates) {
    const next = canonicalDigest(withoutKey(candidate, "candidateSha256"));
    if (next !== candidate.candidateSha256) {
      changed.push(`candidate ${candidate.candidateId}`);
      projectionsText = swapDigest(projectionsText, candidate.candidateSha256, next);
    }
  }
  const reparsed = JSON.parse(projectionsText);
  const nextRegistry = canonicalDigest(withoutKey(reparsed, "registrySha256"));
  if (nextRegistry !== reparsed.registrySha256) {
    changed.push("candidate-projections registry");
    projectionsText = swapDigest(projectionsText, reparsed.registrySha256, nextRegistry);
  }
}
await writeFile(paths.projections, projectionsText);
const projectionRegistrySha256 = JSON.parse(projectionsText).registrySha256;

// ------------------------------------------------------------ workflow catalog
// The catalog pins each workflow manifest's bytes, and
// `installed.ts:validateWorkflowSources` refuses a disagreeing pin, so it is
// resealed before the manifest pass takes the catalog's file digest.
let workflowCatalogText = await readFile(paths.workflowCatalog, "utf8");
{
  const sourcePath = "workflows/reconcile-product-behavior.json";
  const sourceBytes = await readFile(resolve(RUNTIME, sourcePath));
  const semantic = JSON.parse(sourceBytes.toString("utf8"));
  if (
    semantic.schemaVersion !== 1 ||
    semantic.name !== "reconcile-product-behavior" ||
    semantic.steps.length !== 1 ||
    semantic.steps[0].id !== "compare-product-behavior" ||
    semantic.steps[0].skill !== "reconcile-product-behavior" ||
    semantic.steps[0].mode !== "read-only"
  ) {
    throw new Error(
      "semantic workflow must retain its explicit read-only comparison step",
    );
  }
  const value = JSON.parse(workflowCatalogText);
  const entry = {
    workflowId: semantic.name,
    sourcePath,
    sourceSha256: fileSha(sourceBytes),
    steps: [
      {
        stepId: semantic.steps[0].id,
        stepMode: "read-only",
        stepOrdinal: 1,
        skillId: semantic.steps[0].skill,
        role: "product-behavior-analyst",
      },
    ],
  };
  const existing = value.workflows.findIndex(
    (workflow: { workflowId: string }) => workflow.workflowId === semantic.name,
  );
  if (
    existing === -1 ||
    JSON.stringify(value.workflows[existing]) !== JSON.stringify(entry)
  ) {
    if (existing === -1) value.workflows.push(entry);
    else value.workflows[existing] = entry;
    value.workflows.sort(
      (left: { workflowId: string }, right: { workflowId: string }) =>
        left.workflowId.localeCompare(right.workflowId),
    );
    workflowCatalogText = `${JSON.stringify(value, null, 2)}\n`;
    changed.push("semantic workflow catalog topology");
  }
  const parsed = JSON.parse(workflowCatalogText);
  for (const workflow of parsed.workflows) {
    const next = fileSha(await readFile(resolve(RUNTIME, workflow.sourcePath)));
    if (next !== workflow.sourceSha256) {
      changed.push(`workflow source ${workflow.sourcePath}`);
      workflowCatalogText = swapDigest(workflowCatalogText, workflow.sourceSha256, next);
    }
  }
  const reparsed = JSON.parse(workflowCatalogText);
  const nextCatalog = canonicalDigest(withoutKey(reparsed, "catalogSha256"));
  if (nextCatalog !== reparsed.catalogSha256) {
    changed.push("workflow catalog");
    workflowCatalogText = swapDigest(workflowCatalogText, reparsed.catalogSha256, nextCatalog);
  }
}
await writeFile(paths.workflowCatalog, workflowCatalogText);
const workflowCatalogSha256 = JSON.parse(workflowCatalogText).catalogSha256;

// -------------------------------------------------------------------- manifest
let manifestText = await readFile(paths.manifest, "utf8");
{
  const parsed = JSON.parse(manifestText);
  const kinds = parsed.assets.map((asset: { kind: string }) => asset.kind).sort();
  if (
    JSON.stringify(kinds) !==
    JSON.stringify(["adapter-registry", "candidate-projections", "composition-registry", "workflow-catalog"])
  ) {
    throw new Error("installed-manifest.json does not list the four expected assets; refusing to reseal");
  }
  // The package-wide composition ceiling carries its own digest; an edited limit
  // must move it, or every resolver call fails with contract-digest-mismatch.
  const nextCeiling = canonicalDigest(parsed.compositionCeiling);
  if (nextCeiling !== parsed.compositionCeilingSha256) {
    changed.push("manifest compositionCeiling");
    manifestText = swapDigest(manifestText, parsed.compositionCeilingSha256, nextCeiling);
  }
  // Asset digests must be taken from the files as just written, not from memory.
  for (const asset of parsed.assets) {
    const bytes = await readFile(resolve(ROOT, asset.path));
    const nextFile = fileSha(bytes);
    if (asset.fileSha256 !== nextFile) {
      changed.push(`manifest asset file ${asset.path}`);
      manifestText = swapDigest(manifestText, asset.fileSha256, nextFile);
    }
    const nextContract =
      asset.kind === "adapter-registry"
        ? adapterRegistrySha256
        : asset.kind === "composition-registry"
        ? compositionRegistrySha256
        : asset.kind === "candidate-projections"
          ? projectionRegistrySha256
          : asset.kind === "workflow-catalog"
            ? workflowCatalogSha256
            : asset.contractSha256;
    if (asset.contractSha256 !== nextContract) {
      changed.push(`manifest asset contract ${asset.path}`);
      manifestText = swapDigest(manifestText, asset.contractSha256, nextContract);
    }
  }
  const reparsed = JSON.parse(manifestText);
  const nextManifest = canonicalDigest(withoutKey(reparsed, "installedManifestSha256"));
  if (nextManifest !== reparsed.installedManifestSha256) {
    changed.push("installed manifest");
    manifestText = swapDigest(manifestText, reparsed.installedManifestSha256, nextManifest);
  }
}
await writeFile(paths.manifest, manifestText);

// --------------------------------------------------------- compiled source pin
const manifestFileSha256 = fileSha(await readFile(paths.manifest));
let installedTs = await readFile(paths.installedTs, "utf8");
const pinMatch = installedTs.match(
  /const EXPECTED_INSTALLED_MANIFEST_FILE_SHA256 =\s*\n?\s*"([a-f0-9]{64})"/,
);
if (!pinMatch) throw new Error("could not locate EXPECTED_INSTALLED_MANIFEST_FILE_SHA256");
if (pinMatch[1] !== manifestFileSha256) {
  changed.push(`installed manifest source pin ${pinMatch[1]!.slice(0, 12)} -> ${manifestFileSha256.slice(0, 12)}`);
  installedTs = swapDigest(installedTs, pinMatch[1]!, manifestFileSha256);
  await writeFile(paths.installedTs, installedTs);
}

if (changed.length === 0) {
  console.log("composition digest chain already consistent; nothing re-sealed");
} else {
  console.log(`re-sealed ${changed.length} digest(s):\n  ${changed.join("\n  ")}`);
}
