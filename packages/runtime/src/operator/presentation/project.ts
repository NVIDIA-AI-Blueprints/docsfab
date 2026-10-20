// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ActivityPresentationFacts,
  CollectionPresentationFacts,
  DecisionPresentationFacts,
  InspectionPresentationFacts,
  PresentationAction,
  PresentationDetail,
  PresentationDocument,
  PresentationEvidence,
  PresentationField,
  PresentationImportance,
  PresentationRow,
  PresentationSection,
  ResultPresentationFacts,
} from "./types.js";

export interface PresentationOptions {
  readonly detail?: PresentationDetail;
}

const DETAIL_RANK: Readonly<Record<PresentationDetail, number>> = {
  quiet: 0,
  normal: 1,
  verbose: 2,
};

function visible(
  detail: PresentationDetail | undefined,
  importance: PresentationImportance | undefined,
  selected: PresentationDetail,
): boolean {
  return importance === "material" || DETAIL_RANK[detail ?? "normal"] <= DETAIL_RANK[selected];
}

function addField(
  rows: PresentationRow[],
  field: PresentationField,
  detail: PresentationDetail,
): void {
  if (!visible(field.detail, field.importance, detail)) return;
  rows.push({
    kind: "field",
    label: field.label,
    evidence: field.evidence as PresentationEvidence<string>,
    ...(field.stream === undefined ? {} : { stream: field.stream }),
  });
}

function addSections(
  rows: PresentationRow[],
  sections: readonly PresentationSection[] | undefined,
  detail: PresentationDetail,
  promotedSections: ReadonlySet<PresentationSection> = new Set(),
): void {
  for (const section of sections ?? []) {
    if (promotedSections.has(section) && section.importance === "material") continue;
    const sectionVisible = visible(section.detail, section.importance, detail);
    const materialPromoted = promotedSections.has(section);
    const fields = (section.fields ?? []).filter((field) =>
      materialPromoted
        ? sectionVisible &&
          field.importance !== "material" &&
          visible(field.detail, field.importance, detail)
        : sectionVisible
          ? visible(field.detail, field.importance, detail)
          : field.importance === "material",
    );
    if (!sectionVisible && fields.length === 0) continue;
    if (!materialPromoted)
      rows.push({
        kind: "section",
        title: section.title,
        ...(section.stream === undefined ? {} : { stream: section.stream }),
      });
    if (sectionVisible) {
      for (const text of section.text ?? [])
        rows.push({
          kind: "text",
          text,
          ...(section.stream === undefined ? {} : { stream: section.stream }),
        });
      for (const action of section.actions ?? [])
        rows.push({
          kind: "action",
          action,
          ...(section.stream === undefined ? {} : { stream: section.stream }),
        });
    }
    for (const field of fields)
      rows.push({
        kind: "field",
        label: field.label,
        evidence: field.evidence as PresentationEvidence<string>,
        ...((field.stream ?? section.stream) === undefined
          ? {}
          : { stream: field.stream ?? section.stream }),
      });
  }
}

function addMaterialSections(
  rows: PresentationRow[],
  sections: readonly PresentationSection[] | undefined,
  detail: PresentationDetail,
): Set<PresentationSection> {
  const promoted = new Set<PresentationSection>();
  for (const section of sections ?? []) {
    const materialFields = (section.fields ?? []).filter(
      (field) => field.importance === "material",
    );
    if (section.importance !== "material" && materialFields.length === 0) continue;
    if (section.importance === "material") promoted.add(section);
    rows.push({
      kind: "section",
      title: section.title,
      ...(section.stream === undefined ? {} : { stream: section.stream }),
    });
    if (section.importance === "material") {
      for (const text of section.text ?? [])
        rows.push({
          kind: "text",
          text,
          ...(section.stream === undefined ? {} : { stream: section.stream }),
        });
      for (const action of section.actions ?? [])
        rows.push({
          kind: "action",
          action,
          ...(section.stream === undefined ? {} : { stream: section.stream }),
        });
      for (const field of (section.fields ?? []).filter(
        (item) =>
          section.importance === "material" || visible(item.detail, item.importance, detail),
      )) {
        rows.push({
          kind: "field",
          label: field.label,
          evidence: field.evidence as PresentationEvidence<string>,
          ...((field.stream ?? section.stream) === undefined
            ? {}
            : { stream: field.stream ?? section.stream }),
        });
      }
    } else {
      promoted.add(section);
      for (const field of materialFields)
        rows.push({
          kind: "field",
          label: field.label,
          evidence: field.evidence as PresentationEvidence<string>,
          ...((field.stream ?? section.stream) === undefined
            ? {}
            : { stream: field.stream ?? section.stream }),
        });
    }
  }
  return promoted;
}

function appendAttention(
  rows: PresentationRow[],
  attention: ResultPresentationFacts["attention"],
): void {
  if (attention === null) return;
  rows.push({
    kind: "attention",
    message: attention.message,
    ...(attention.stream === undefined ? {} : { stream: attention.stream }),
  });
  for (const field of attention.details ?? []) {
    rows.push({
      kind: "field",
      label: field.label,
      evidence: field.evidence as PresentationEvidence<string>,
      ...((attention.stream ?? field.stream) === undefined
        ? {}
        : { stream: attention.stream ?? field.stream }),
    });
  }
}

function makeDocument(
  title: string,
  attention: ResultPresentationFacts["attention"],
  rows: readonly PresentationRow[],
  actions: readonly PresentationAction[] = [],
): PresentationDocument {
  return { title, attention, rows, actions };
}

export function presentResult(
  facts: ResultPresentationFacts,
  options: PresentationOptions = {},
): PresentationDocument {
  const detail = options.detail ?? "normal";
  const rows: PresentationRow[] = [];
  if (facts.summary !== undefined) rows.push({ kind: "summary", text: facts.summary });
  addField(rows, { ...facts.outcome, detail: "quiet" }, detail);
  if (facts.scope !== undefined) addField(rows, { ...facts.scope, detail: "quiet" }, detail);
  for (const field of facts.statusPlanes ?? [])
    addField(rows, { ...field, detail: "quiet" }, detail);
  for (const field of [...(facts.effects ?? []), ...(facts.limitations ?? [])]) {
    if (field.importance === "material") addField(rows, field, detail);
  }
  const promotedSections = addMaterialSections(rows, facts.sections, detail);
  appendAttention(rows, facts.attention);
  if (facts.primaryAction !== undefined)
    rows.push({ kind: "section", title: "NEXT" }, { kind: "action", action: facts.primaryAction });
  for (const action of facts.nextActions ?? []) rows.push({ kind: "action", action });
  for (const artifact of facts.artifacts ?? []) rows.push({ kind: "action", action: artifact });
  for (const field of [...(facts.effects ?? []), ...(facts.limitations ?? [])]) {
    if (field.importance !== "material") addField(rows, field, detail);
  }
  addSections(rows, facts.sections, detail, promotedSections);
  const actions = [
    ...(facts.primaryAction === undefined ? [] : [facts.primaryAction]),
    ...(facts.nextActions ?? []),
    ...(facts.artifacts ?? []),
  ];
  return makeDocument(facts.title, facts.attention, rows, actions);
}

export function presentInspection(
  facts: InspectionPresentationFacts,
  options: PresentationOptions = {},
): PresentationDocument {
  const detail = options.detail ?? "normal";
  const rows: PresentationRow[] = [{ kind: "field", label: "Subject", evidence: facts.subject }];
  appendAttention(rows, facts.attention);
  for (const finding of facts.findings)
    rows.push({
      kind: "field",
      label: finding.label,
      evidence: finding.evidence as PresentationEvidence<string>,
      ...(finding.stream === undefined ? {} : { stream: finding.stream }),
    });
  addSections(rows, facts.sections, detail);
  for (const action of facts.actions ?? []) rows.push({ kind: "action", action });
  return makeDocument(facts.title, facts.attention, rows, facts.actions);
}

export function presentCollection(
  facts: CollectionPresentationFacts,
  options: PresentationOptions = {},
): PresentationDocument {
  const detail = options.detail ?? "normal";
  const rows: PresentationRow[] = [];
  appendAttention(rows, facts.attention);
  for (const entry of facts.entries)
    rows.push({
      kind: "field",
      label: entry.label,
      evidence: entry.evidence as PresentationEvidence<string>,
      ...(entry.stream === undefined ? {} : { stream: entry.stream }),
    });
  addSections(rows, facts.sections, detail);
  for (const action of facts.actions ?? []) rows.push({ kind: "action", action });
  return makeDocument(facts.title, facts.attention, rows, facts.actions);
}

export function presentDecision(
  facts: DecisionPresentationFacts,
  options: PresentationOptions = {},
): PresentationDocument {
  const detail = options.detail ?? "normal";
  const rows: PresentationRow[] = [{ kind: "summary", text: facts.question }];
  appendAttention(rows, facts.attention);
  for (const choice of facts.choices)
    rows.push({
      kind: "field",
      label: choice.label,
      evidence: choice.evidence as PresentationEvidence<string>,
      ...(choice.stream === undefined ? {} : { stream: choice.stream }),
    });
  if (facts.selected !== undefined) {
    rows.push({ kind: "field", label: "Selected", evidence: facts.selected });
  }
  for (const action of facts.actions ?? []) rows.push({ kind: "action", action });
  return makeDocument(facts.title, facts.attention, rows, facts.actions);
}

export function presentActivity(
  facts: ActivityPresentationFacts,
  options: PresentationOptions = {},
): PresentationDocument {
  const detail = options.detail ?? "normal";
  const rows: PresentationRow[] = [];
  appendAttention(rows, facts.attention);
  for (const event of facts.events) {
    if (!visible(event.detail, event.importance, detail)) continue;
    rows.push({
      kind: "activity",
      identity: event.identity,
      phase: event.phase,
      message: event.message,
      observedWait: event.observedWait ?? false,
      ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
      ...(event.stream === undefined ? {} : { stream: event.stream }),
    });
  }
  addSections(rows, facts.sections, detail);
  for (const action of facts.actions ?? []) rows.push({ kind: "action", action });
  return makeDocument(facts.title, facts.attention, rows, facts.actions);
}
