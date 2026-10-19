// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { limit } from "../config/limits.js";
import { escapeUndisplayable } from "../shared/display-text.js";
import type { RunRecord, RunStore } from "./contracts.js";
import { isRecordableEvidenceWarning } from "./evidence-warnings.js";

/**
 * Warnings a run collects outside its steps, such as a provider that served a
 * renamed model. They are recorded and shown; none stops the run.
 */
export interface RunNotes {
  add(note: string): void;
  list(): readonly string[];
  /** Call `listener` with each new note as it arrives, so the run can show it. */
  onNote(listener: (note: string) => void): void;
}

export function createRunNotes(): RunNotes {
  const notes: string[] = [];
  const listeners: Array<(note: string) => void> = [];
  return {
    add(note) {
      if (notes.includes(note)) return;
      notes.push(note);
      // A note can carry provider text, such as a served model name.
      const shown = displayRunNote(note);
      for (const listener of listeners) listener(shown);
    },
    list: () => [...notes],
    onNote(listener) {
      listeners.push(listener);
    },
  };
}

const PLACEHOLDER =
  "A run warning was too long or held a control character, so the run record keeps this placeholder instead.";

/**
 * A note as a listener shows it at once. By the rule the run record applies,
 * a note the record keeps is shown as it is. One the record replaces with its
 * placeholder, such as a served model name a provider sent with a control or
 * format character or at extreme length, is shown with each undisplayable
 * code point escaped as `\u{...}`, bounded at `runs.indexFieldMaxChars`, the
 * longest model name the run index copies.
 */
export function displayRunNote(note: string): string {
  if (isRecordableEvidenceWarning(note)) return note;
  const escaped = escapeUndisplayable(note);
  const maxChars = limit("runs.indexFieldMaxChars").value;
  return escaped.length <= maxChars
    ? escaped
    : `${escaped.slice(0, maxChars)} [${String(escaped.length - maxChars)} more characters not shown]`;
}

/** Append every note collected so far to the record's `evidenceWarnings`, once each. */
export function addRunNotes(record: RunRecord, notes: RunNotes): void {
  const kept = new Set(record.evidenceWarnings ?? []);
  const added = notes
    .list()
    .map((note) => (isRecordableEvidenceWarning(note) ? note : PLACEHOLDER))
    .filter((note) => {
      if (kept.has(note)) return false;
      kept.add(note);
      return true;
    });
  if (added.length > 0) record.evidenceWarnings = [...(record.evidenceWarnings ?? []), ...added];
}

/**
 * Append the notes to `evidenceWarnings` on each save. The runner may save a
 * copy of its record, so each save adds them again; a note already on the
 * record is not repeated.
 */
export function notingRunStore(store: RunStore, notes: RunNotes): RunStore {
  return {
    async save(record: RunRecord): Promise<void> {
      addRunNotes(record, notes);
      await store.save(record);
    },
  };
}
