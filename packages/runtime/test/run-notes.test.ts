// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run notes are warnings a run collects outside its steps, such as a renamed
 * served model. Each is shown as it arrives and recorded once; a note the
 * record cannot hold leaves a placeholder instead of vanishing.
 */
import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { addRunNotes, createRunNotes, notingRunStore } from "../src/records/run-notes.js";

const PLACEHOLDER =
  "A run warning was too long or held a control character, so the run record keeps this placeholder instead.";

function record(evidenceWarnings?: string[]): RunRecord {
  return {
    id: "run-notes-fixture",
    ...(evidenceWarnings ? { evidenceWarnings } : {}),
  } as RunRecord;
}

describe("run notes", () => {
  it("shows each new note once as it arrives", () => {
    const notes = createRunNotes();
    const shown: string[] = [];
    notes.onNote((note) => shown.push(note));
    notes.add("The provider served a renamed model.");
    notes.add("The provider served a renamed model.");
    notes.add("A second warning.");
    expect(shown).toEqual(["The provider served a renamed model.", "A second warning."]);
    expect(notes.list()).toEqual(["The provider served a renamed model.", "A second warning."]);
  });

  it("records each note once, after the record's own warnings", () => {
    const notes = createRunNotes();
    notes.add("Already on the record.");
    notes.add("New warning.");
    const saved = record(["Already on the record."]);
    addRunNotes(saved, notes);
    addRunNotes(saved, notes);
    expect(saved.evidenceWarnings).toEqual(["Already on the record.", "New warning."]);
  });

  it.each([
    { name: "a control character", note: "Line one\nline two" },
    { name: "more than 1,024 characters", note: "w".repeat(1_025) },
  ])("keeps a placeholder for a note with $name instead of dropping it", ({ note }) => {
    const notes = createRunNotes();
    notes.add(note);
    notes.add(`${note} again`);
    const saved = record();
    addRunNotes(saved, notes);
    // Both unrecordable notes collapse to one placeholder.
    expect(saved.evidenceWarnings).toEqual([PLACEHOLDER]);
  });

  it("shows a note the record cannot hold escaped and bounded, and still records the placeholder", () => {
    const notes = createRunNotes();
    const shown: string[] = [];
    notes.onNote((note) => shown.push(note));
    // Provider text: a terminal escape and a line break, then an extreme length.
    notes.add("Served gateway/\u001b[31mred\u001b[0m\nname for example/model.");
    notes.add(`Served ${"m".repeat(5_000)} for example/model.`);

    expect(shown[0]).toBe("Served gateway/\\u{1b}[31mred\\u{1b}[0m\\u{a}name for example/model.");
    const maxChars = limit("runs.indexFieldMaxChars").value;
    const omitted = 5_000 + "Served  for example/model.".length - maxChars;
    expect(shown[1]).toBe(
      `${`Served ${"m".repeat(5_000)}`.slice(0, maxChars)} [${String(omitted)} more characters not shown]`,
    );
    for (const note of shown) expect(note).not.toMatch(/[\u0000-\u001f\u007f]/u);
    const saved = record();
    addRunNotes(saved, notes);
    expect(saved.evidenceWarnings).toEqual([PLACEHOLDER]);
  });

  it.each([
    ["a C1 control (CSI)", "\u009b", "\\u{9b}"],
    ["a right-to-left override", "\u202e", "\\u{202e}"],
    ["a left-to-right isolate", "\u2066", "\\u{2066}"],
    ["a line separator", "\u2028", "\\u{2028}"],
  ])("shows %s escaped and records the placeholder", (_name, character, escaped) => {
    const notes = createRunNotes();
    const shown: string[] = [];
    notes.onNote((note) => shown.push(note));
    notes.add(`Served gateway/${character}renamed for example/model.`);

    expect(shown).toEqual([`Served gateway/${escaped}renamed for example/model.`]);
    const saved = record();
    addRunNotes(saved, notes);
    expect(saved.evidenceWarnings).toEqual([PLACEHOLDER]);
  });

  it("leaves a record with no notes unchanged (control)", () => {
    const saved = record();
    addRunNotes(saved, createRunNotes());
    expect(saved).not.toHaveProperty("evidenceWarnings");
  });

  it("adds the notes on every save through the store", async () => {
    const notes = createRunNotes();
    const writes: RunRecord[] = [];
    const store = notingRunStore(
      {
        async save(saved) {
          writes.push(structuredClone(saved));
        },
      } as RunStore,
      notes,
    );
    await store.save(record());
    notes.add("Arrived mid-run.");
    await store.save(record());
    expect(writes.map((saved) => saved.evidenceWarnings)).toEqual([
      undefined,
      ["Arrived mid-run."],
    ]);
  });
});
