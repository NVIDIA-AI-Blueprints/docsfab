#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-seal the composition turn budget across the digest-sealed composition chain.
 *
 * The effective limit is `Math.min(configured, candidate, composition, package)`
 * (records/composition-execution.ts), so raising one source does nothing — every
 * source has to move together or the smallest silently wins.
 *
 * Substitution is textual, not a JSON round-trip: asset digests are taken over
 * file bytes, so re-serialising would change every `fileSha256` and bury the
 * real change. Parsing only computes digests; writing replaces exact
 * substrings.
 *
 * Run `verify-composition-digests.mts` before (it proves the digest rule
 * reproduces the committed digests) and after (it proves the chain is
 * consistent). A self-consistent chain cannot catch an author sealing a wrong
 * value.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalDigest } from "../src/content-ir/canonical.js";

const FROM = 4;
const TO = 128;

const RUNTIME = resolve(import.meta.dirname, "..");
const ROOT = resolve(RUNTIME, "model-compositions");
const paths = {
  projections: resolve(ROOT, "candidate-projections.json"),
  compositions: resolve(ROOT, "composition-registry.json"),
  manifest: resolve(ROOT, "installed-manifest.json"),
  installedTs: resolve(RUNTIME, "src/model-composition/installed-manifest-pin.js"),
};

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

// Anchored: a bare `split('"maxProviderTurns": 4')` also matches the prefix of
// `"maxProviderTurns": 40`, and the recomputed digests would seal the wrong
// value as valid. The negative lookahead admits only a whole number.
const turnsPattern = (): RegExp => new RegExp(`("maxProviderTurns":\\s*)${FROM}(?![0-9])`, "gu");
const substituteTurns = (text: string): { text: string; count: number } => {
  let count = 0;
  const next = text.replace(turnsPattern(), (_match, prefix: string) => {
    count += 1;
    return `${prefix}${TO}`;
  });
  return { text: next, count };
};

// ---------------------------------------------------------------- compositions
let compositionsText = await readFile(paths.compositions, "utf8");
const compositionSubstitution = substituteTurns(compositionsText);
const compositionHits = compositionSubstitution.count;
compositionsText = compositionSubstitution.text;
{
  const parsed = JSON.parse(compositionsText);
  for (const composition of parsed.compositions) {
    const next = canonicalDigest(withoutKey(composition, "compositionSha256"));
    compositionsText = swapDigest(compositionsText, composition.compositionSha256, next);
    composition.compositionSha256 = next;
  }
  const reparsed = JSON.parse(compositionsText);
  const nextRegistry = canonicalDigest(withoutKey(reparsed, "registrySha256"));
  compositionsText = swapDigest(compositionsText, reparsed.registrySha256, nextRegistry);
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
const projectionSubstitution = substituteTurns(projectionsText);
const projectionHits = projectionSubstitution.count;
projectionsText = projectionSubstitution.text;
{
  // A candidate embeds the digest of the composition it projects onto, so the
  // composition pass above must land first or these would reference the old one.
  const parsed = JSON.parse(projectionsText);
  for (const candidate of parsed.candidates) {
    const compositionSha256 = compositionDigestById.get(candidate.compositionId);
    if (!compositionSha256) throw new Error(`no composition for ${candidate.compositionId}`);
    if (candidate.compositionSha256 !== compositionSha256) {
      projectionsText = swapDigest(projectionsText, candidate.compositionSha256, compositionSha256);
    }
  }
  for (const candidate of JSON.parse(projectionsText).candidates) {
    const next = canonicalDigest(withoutKey(candidate, "candidateSha256"));
    projectionsText = swapDigest(projectionsText, candidate.candidateSha256, next);
  }
  const reparsed = JSON.parse(projectionsText);
  const nextRegistry = canonicalDigest(withoutKey(reparsed, "registrySha256"));
  projectionsText = swapDigest(projectionsText, reparsed.registrySha256, nextRegistry);
}
await writeFile(paths.projections, projectionsText);
const projectionRegistrySha256 = JSON.parse(projectionsText).registrySha256;

// -------------------------------------------------------------------- manifest
let manifestText = await readFile(paths.manifest, "utf8");
const manifestSubstitution = substituteTurns(manifestText);
const manifestHits = manifestSubstitution.count;
manifestText = manifestSubstitution.text;
{
  const parsed = JSON.parse(manifestText);
  const nextCeiling = canonicalDigest(
    withoutKey(parsed.compositionCeiling, "compositionCeilingSha256"),
  );
  manifestText = swapDigest(manifestText, parsed.compositionCeilingSha256, nextCeiling);

  // Asset digests must be taken from the files as just written, not from memory.
  for (const asset of JSON.parse(manifestText).assets) {
    const bytes = await readFile(resolve(ROOT, asset.path));
    const nextFile = fileSha(bytes);
    if (asset.fileSha256 !== nextFile) {
      manifestText = swapDigest(manifestText, asset.fileSha256, nextFile);
    }
    const nextContract =
      asset.kind === "composition-registry"
        ? compositionRegistrySha256
        : asset.kind === "candidate-projections"
          ? projectionRegistrySha256
          : asset.contractSha256;
    if (asset.contractSha256 !== nextContract) {
      manifestText = swapDigest(manifestText, asset.contractSha256, nextContract);
    }
  }
  const reparsed = JSON.parse(manifestText);
  const nextManifest = canonicalDigest(withoutKey(reparsed, "installedManifestSha256"));
  manifestText = swapDigest(manifestText, reparsed.installedManifestSha256, nextManifest);
}
await writeFile(paths.manifest, manifestText);

// --------------------------------------------------------- compiled source pin
const manifestFileSha256 = fileSha(await readFile(paths.manifest));
let installedTs = await readFile(paths.installedTs, "utf8");
const pinMatch = installedTs.match(
  /const EXPECTED_INSTALLED_MANIFEST_FILE_SHA256 =\s*\n?\s*"([a-f0-9]{64})"/,
);
if (!pinMatch) throw new Error("could not locate EXPECTED_INSTALLED_MANIFEST_FILE_SHA256");
installedTs = swapDigest(installedTs, pinMatch[1]!, manifestFileSha256);
await writeFile(paths.installedTs, installedTs);

console.log(
  [
    `maxProviderTurns ${FROM} -> ${TO}`,
    `  composition-registry.json     ${compositionHits} occurrence(s)`,
    `  candidate-projections.json    ${projectionHits} occurrence(s)`,
    `  installed-manifest.json       ${manifestHits} occurrence(s)`,
    `  installed manifest source pin ${pinMatch[1]!.slice(0, 12)} -> ${manifestFileSha256.slice(0, 12)}`,
  ].join("\n"),
);
if (compositionHits === 0 || projectionHits === 0 || manifestHits === 0) {
  console.error("refusing to report success: a source had zero occurrences to update");
  process.exitCode = 1;
}
