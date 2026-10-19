// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, canonicalJson } from "../../content-ir/canonical.js";
import {
  DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
  DOCUMENTATION_MATURITY_EVALUATOR_CATALOG,
  DOCUMENTATION_MATURITY_GATE_CATALOG,
} from "../../maturity/index.js";
import type {
  MaturityCascadeBaselineCaseV1,
  MaturityCascadeBaselineV1,
  MaturityCascadeDatasetCaseV1,
  MaturityCascadeDatasetTransitionV1,
  MaturityCascadeDatasetV1,
  MaturityCascadePortableFindingV1,
  MaturityCascadePortableSelectionV1,
} from "../maturity-cascade.js";
import {
  disposition,
  exact,
  gateId,
  invalid,
  record,
  safeId,
  safeMissingInputId,
  safePath,
  sha,
  sortedUnique,
} from "./value-primitives.js";

const MAXIMUM_TRANSITION_CHANGES = 128;

export function validateMaturityCascadeDataset(value: unknown): MaturityCascadeDatasetV1 {
  const root = record(value);
  exact(root, ["schemaVersion", "kind", "id", "revision", "cases", "datasetSha256"]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-maturity-cascade-dataset") invalid();
  const id = safeId(root.id);
  const revision = sha(root.revision);
  if (!Array.isArray(root.cases) || root.cases.length !== 8) invalid();
  const cases = root.cases.map(decodeDatasetCase);
  if (!sortedUnique(cases.map((item) => item.id))) invalid();
  validateRevisionChain(cases);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-maturity-cascade-dataset" as const,
    id,
    revision,
    cases,
  };
  const datasetSha256 = sha(root.datasetSha256);
  if (revision !== canonicalDigest(cases) || datasetSha256 !== canonicalDigest(body)) invalid();
  const result = { ...body, datasetSha256 };
  if (canonicalJson(result) !== canonicalJson(value)) invalid();
  return result;
}

export function maturityCascadeDatasetTransitions(
  value: MaturityCascadeDatasetV1,
): MaturityCascadeDatasetTransitionV1[] {
  return deriveDatasetTransitions(validateMaturityCascadeDataset(value).cases);
}

export function validateMaturityCascadeBaseline(
  value: unknown,
  dataset: MaturityCascadeDatasetV1,
): MaturityCascadeBaselineV1 {
  const root = record(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "dataset",
    "algorithmVersion",
    "gateCatalogSha256",
    "evaluatorCatalogSha256",
    "reviewerPolicySha256",
    "cases",
    "baselineSha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-maturity-cascade-known-answer-baseline" ||
    root.algorithmVersion !== DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION ||
    root.gateCatalogSha256 !== DOCUMENTATION_MATURITY_GATE_CATALOG.catalogSha256 ||
    root.evaluatorCatalogSha256 !== DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.catalogSha256
  )
    invalid();
  const binding = record(root.dataset);
  exact(binding, ["id", "revision", "sha256"]);
  const datasetBinding = {
    id: safeId(binding.id),
    revision: sha(binding.revision),
    sha256: sha(binding.sha256),
  };
  if (
    canonicalJson(datasetBinding) !==
    canonicalJson({
      id: dataset.id,
      revision: dataset.revision,
      sha256: dataset.datasetSha256,
    })
  )
    invalid();
  if (!Array.isArray(root.cases) || root.cases.length !== dataset.cases.length) invalid();
  const cases = root.cases.map(decodeBaselineCase);
  if (
    canonicalJson(cases.map((item) => item.id)) !==
    canonicalJson(dataset.cases.map((item) => item.id))
  )
    invalid();
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-maturity-cascade-known-answer-baseline" as const,
    dataset: datasetBinding,
    algorithmVersion: DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
    gateCatalogSha256: DOCUMENTATION_MATURITY_GATE_CATALOG.catalogSha256,
    evaluatorCatalogSha256: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.catalogSha256,
    reviewerPolicySha256: sha(root.reviewerPolicySha256),
    cases,
  };
  const baselineSha256 = sha(root.baselineSha256);
  if (baselineSha256 !== canonicalDigest(body)) invalid();
  const result = { ...body, baselineSha256 };
  if (canonicalJson(result) !== canonicalJson(value)) invalid();
  return result;
}

function decodeDatasetCase(value: unknown): MaturityCascadeDatasetCaseV1 {
  const root = record(value);
  exact(root, ["id", "kind", "predecessorId", "sources", "caseSha256"]);
  const id = safeId(root.id);
  const kinds = [
    "no-documentation",
    "partial-coverage",
    "broken-ia",
    "monolithic-content",
    "stale-inaccurate",
    "polish-only",
    "complete",
    "human-decision",
  ] as const;
  if (
    !kinds.includes(root.kind as (typeof kinds)[number]) ||
    (root.predecessorId !== null && typeof root.predecessorId !== "string") ||
    !Array.isArray(root.sources) ||
    root.sources.length === 0 ||
    root.sources.length > 64
  )
    invalid();
  const sources = root.sources.map((source) => {
    const item = record(source);
    exact(item, ["path", "fixturePath", "sha256"]);
    return {
      path: safePath(item.path),
      fixturePath: safePath(item.fixturePath),
      sha256: sha(item.sha256),
    };
  });
  if (!sortedUnique(sources.map((source) => source.path))) invalid();
  const body = {
    id,
    kind: root.kind as MaturityCascadeDatasetCaseV1["kind"],
    predecessorId: root.predecessorId as string | null,
    sources,
  };
  const caseSha256 = sha(root.caseSha256);
  if (caseSha256 !== canonicalDigest(body)) invalid();
  return { ...body, caseSha256 };
}

function decodeBaselineCase(value: unknown): MaturityCascadeBaselineCaseV1 {
  const root = record(value);
  exact(root, [
    "id",
    "gateDispositions",
    "majorFindings",
    "selection",
    "forbiddenFindingKeys",
    "caseBaselineSha256",
  ]);
  const id = safeId(root.id);
  if (
    !Array.isArray(root.gateDispositions) ||
    root.gateDispositions.length !== 6 ||
    !Array.isArray(root.majorFindings) ||
    !Array.isArray(root.forbiddenFindingKeys)
  )
    invalid();
  const gateDispositions = root.gateDispositions.map((value) => {
    const item = record(value);
    exact(item, ["gateId", "disposition"]);
    return { gateId: gateId(item.gateId), disposition: disposition(item.disposition) };
  });
  const majorFindings = root.majorFindings.map((value) => {
    const item = record(value);
    exact(item, ["gateId", "findingKey", "severity", "affectedPaths", "portableFingerprint"]);
    if (
      (item.severity !== "critical" && item.severity !== "major") ||
      !Array.isArray(item.affectedPaths)
    )
      invalid();
    return {
      gateId: gateId(item.gateId),
      findingKey: safeId(item.findingKey),
      severity: item.severity as MaturityCascadePortableFindingV1["severity"],
      affectedPaths: item.affectedPaths.map(safePath),
      portableFingerprint: sha(item.portableFingerprint),
    };
  });
  const selectionValue = record(root.selection);
  exact(selectionValue, [
    "state",
    "gateId",
    "findingKey",
    "missingInputIds",
    "portableWorkUnitFingerprint",
  ]);
  if (
    !["selected", "needs-input", "investigation", "no-action"].includes(
      selectionValue.state as string,
    ) ||
    !Array.isArray(selectionValue.missingInputIds)
  )
    invalid();
  const selection: MaturityCascadePortableSelectionV1 = {
    state: selectionValue.state as MaturityCascadePortableSelectionV1["state"],
    gateId: selectionValue.gateId === null ? null : gateId(selectionValue.gateId),
    findingKey: selectionValue.findingKey === null ? null : safeId(selectionValue.findingKey),
    missingInputIds: selectionValue.missingInputIds.map(safeMissingInputId),
    portableWorkUnitFingerprint:
      selectionValue.portableWorkUnitFingerprint === null
        ? null
        : sha(selectionValue.portableWorkUnitFingerprint),
  };
  const forbiddenFindingKeys = root.forbiddenFindingKeys.map(safeId);
  const body = { id, gateDispositions, majorFindings, selection, forbiddenFindingKeys };
  const caseBaselineSha256 = sha(root.caseBaselineSha256);
  if (caseBaselineSha256 !== canonicalDigest(body)) invalid();
  return { ...body, caseBaselineSha256 };
}

function validateRevisionChain(cases: MaturityCascadeDatasetCaseV1[]): void {
  const chain = [
    "no-doc",
    "partial",
    "broken-ia",
    "monolithic",
    "stale-inaccurate",
    "polish-only",
    "complete",
  ];
  for (let index = 0; index < chain.length; index += 1) {
    const item = cases.find((candidate) => candidate.id === chain[index]);
    if (!item || item.predecessorId !== (index === 0 ? null : chain[index - 1])) invalid();
  }
  const human = cases.find((item) => item.id === "human-decision");
  if (!human || human.predecessorId !== "complete") invalid();
  const transitions = deriveDatasetTransitions(cases);
  if (
    transitions.length !== cases.length - 1 ||
    transitions.some(
      (transition) =>
        transition.changes.length === 0 || transition.changes.length > MAXIMUM_TRANSITION_CHANGES,
    )
  )
    invalid();
}

export function deriveDatasetTransitions(
  cases: readonly MaturityCascadeDatasetCaseV1[],
): MaturityCascadeDatasetTransitionV1[] {
  return cases
    .filter((item) => item.predecessorId !== null)
    .map((item) => {
      const predecessor = cases.find((candidate) => candidate.id === item.predecessorId);
      if (!predecessor) invalid();
      const predecessorSources = new Map(
        predecessor.sources.map((source) => [source.path, source]),
      );
      const currentSources = new Map(item.sources.map((source) => [source.path, source]));
      const paths = [...new Set([...predecessorSources.keys(), ...currentSources.keys()])].sort();
      const changes = paths.flatMap((path): MaturityCascadeDatasetTransitionV1["changes"] => {
        const before = predecessorSources.get(path)?.sha256 ?? null;
        const after = currentSources.get(path)?.sha256 ?? null;
        if (before === after) return [];
        return [
          {
            path,
            kind:
              before === null
                ? ("added" as const)
                : after === null
                  ? ("removed" as const)
                  : ("modified" as const),
            predecessorSha256: before,
            currentSha256: after,
          },
        ];
      });
      if (changes.length > MAXIMUM_TRANSITION_CHANGES) invalid();
      const body = {
        predecessorId: predecessor.id,
        caseId: item.id,
        predecessorCaseSha256: predecessor.caseSha256,
        caseSha256: item.caseSha256,
        changes,
      };
      return { ...body, transitionSha256: canonicalDigest(body) };
    })
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
}
