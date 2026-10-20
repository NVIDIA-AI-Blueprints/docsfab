// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limit, limitDefinition } from "../src/config/limits.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { classifyInferenceAttempt } from "../src/operator/failure-classification.js";
import {
  READ_EVIDENCE_NOTICE_PREFIX,
  READ_LOOP_REPEAT_STREAK_LIMIT,
  READ_LOOP_UNCHANGED_RE_READS_LIMIT,
  READ_LOOP_WITHHELD_READS_LIMIT,
  ReadEvidenceLedger,
  isUsefulProgress,
  resolveReadLoopPolicy,
  withReadEvidence,
} from "../src/harness/read-evidence.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporaryDirectories = temporaryRoots();

/** Small bounds through the shipped overrides, so each case stays short. */
const SMALL = {
  environment: {
    DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "2",
    DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "2",
    DOCSFAB_EXECUTION_READ_LOOP_UNCHANGED_RE_READS: "6",
  },
};

function text(value: string) {
  return [{ type: "text", text: value }];
}

function ledger(turn = 1, options = SMALL) {
  const value = new ReadEvidenceLedger(resolveReadLoopPolicy(options));
  value.bindTurnSource(() => turn);
  return value;
}

/** A read tool over a mutable file map, wrapped exactly as the confined tool set wraps it. */
function readTool(files: Map<string, string>, target: ReadEvidenceLedger) {
  return withReadEvidence(
    {
      name: "read",
      async execute(_id: string, args: { path: string; offset?: number }) {
        const body = files.get(args.path);
        if (body === undefined) throw new Error(`ENOENT: ${args.path}`);
        const lines = body.split("\n").slice((args.offset ?? 1) - 1);
        return { content: text(lines.join("\n")), details: {} };
      },
    },
    target,
  );
}

function bodyOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("\n---\n");
}

describe("read-evidence ledger", () => {
  it("ships the three bounds at the catalog defaults the matrix evidence sized", () => {
    expect(limit(READ_LOOP_REPEAT_STREAK_LIMIT, { environment: {} }).value).toBe(8);
    expect(limit(READ_LOOP_WITHHELD_READS_LIMIT, { environment: {} }).value).toBe(8);
    expect(limit(READ_LOOP_UNCHANGED_RE_READS_LIMIT, { environment: {} }).value).toBe(16);
    const policy = resolveReadLoopPolicy({ environment: {} });
    expect(policy.repeatStreak.refusal).toBe("execution-read-loop-repeat-streak-bound");
    expect(policy.withheldReads.refusal).toBe("execution-read-loop-withheld-reads-bound");
    expect(policy.unchangedReReads.refusal).toBe("execution-read-loop-unchanged-re-reads-bound");
    // The catalog cannot reference another entry, so pin each maximum to the
    // per-step tool-call ceiling it restates.
    const ceiling = limitDefinition("compositionExecution.maxToolCallsPerStep").max;
    expect(limitDefinition(READ_LOOP_REPEAT_STREAK_LIMIT).max).toBe(ceiling);
    expect(limitDefinition(READ_LOOP_WITHHELD_READS_LIMIT).max).toBe(ceiling);
    expect(limitDefinition(READ_LOOP_UNCHANGED_RE_READS_LIMIT).max).toBe(ceiling);
  });

  it("delivers repeats in full with a notice, then the notice alone, then stops by name", async () => {
    const target = ledger(7);
    const tool = readTool(new Map([["docs/guide.md", "# Guide\nbody"]]), target);
    const first = await tool.execute("c1", { path: "docs/guide.md" });
    expect(bodyOf(first)).toBe("# Guide\nbody");
    expect(target.takeClassification("c1")).toBe("new-evidence");

    for (const [index, id] of ["c2", "c3"].entries()) {
      const repeat = await tool.execute(id, { path: "docs/guide.md" });
      expect(repeat.content[0]).toEqual({ type: "text", text: "# Guide\nbody" });
      expect(repeat.content[1]?.text).toContain(
        `${READ_EVIDENCE_NOTICE_PREFIX} This read result for docs/guide.md is unchanged since turn 7`,
      );
      expect(repeat.content[1]?.text).toContain(`(re-read ${index + 1} times;`);
      expect(target.takeClassification(id)).toBe("repeat");
    }
    expect(target.stopDue).toBe(false);

    const withheld = await tool.execute("c4", { path: "docs/guide.md" });
    expect(withheld.content).toHaveLength(1);
    expect(bodyOf(withheld)).not.toContain("body");
    expect(bodyOf(withheld)).toContain(
      "Not re-sent: this read result for docs/guide.md is unchanged since turn 7, and that content is still in your context.",
    );
    expect(target.takeClassification("c4")).toBe("withheld");
    await tool.execute("c5", { path: "docs/guide.md" });
    expect(target.stopDue).toBe(false);
    await tool.execute("c6", { path: "docs/guide.md" });
    expect(target.stopDue).toBe(true);
    expect(target.stopMessage()).toBe(
      "execution-read-loop-withheld-reads-bound: 3 exceeds execution.readLoopWithheldReads = 2 count. The step re-read unchanged content instead of finishing. Retry the step (the correction policy decides), narrow its scope, or raise DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS (up to 400). Follow the named remediation. Read loop in this step attempt: one unchanged result was re-read 5 times with no progress call between (5 unchanged re-reads in the attempt).",
    );
  });

  it("counts calls denied after a conclude-now ask toward the same stop, across a compaction", async () => {
    const target = ledger(7);
    const tool = readTool(new Map([["docs/guide.md", "# Guide\nbody"]]), target);
    for (const id of ["c1", "c2", "c3", "c4"]) await tool.execute(id, { path: "docs/guide.md" });
    // The first withheld re-read: the point where a conclude-now retry asks.
    expect(target.counters()).toMatchObject({ withheld: 1, deniedAfterAsk: 0 });
    expect(target.noticeOnlyAnswers).toBe(1);
    target.recordDeniedAfterAsk(1);
    expect(target.stopDue).toBe(false);
    // A compaction clears what was delivered, not the denied calls.
    target.startEpoch();
    expect(target.noticeOnlyAnswers).toBe(1);
    target.recordDeniedAfterAsk(2);
    expect(target.stopDue).toBe(true);
    expect(target.stopRejection()).toEqual({
      code: "execution-read-loop-withheld-reads-bound",
      location: "$.tools",
    });
    expect(target.stopMessage()).toContain(
      "execution-read-loop-withheld-reads-bound: 3 exceeds execution.readLoopWithheldReads = 2 count.",
    );
    expect(target.stopMessage()).toContain(
      "After the host withdrew the tools and asked for the answer, the model made 3 more tool calls, each denied.",
    );
    // The record keeps the denied count beside the read counts.
    expect(target.snapshot()).toEqual({
      unchangedReReads: 3,
      withheld: 1,
      maxRepeatsOfOneResult: 3,
      maxUnchangedReReadsAcrossResults: 3,
      deniedAfterAsk: 3,
    });
  });

  it("decodes the denied count only within the governance stops that record those calls", () => {
    const tools = (deniedAfterAsk: unknown, governanceStops: number, unchangedReReads = 3) => ({
      totalCalls: 4,
      failedCalls: 0,
      byTool: [{ name: "read", calls: 4, failures: 0 }],
      failureCategories: [{ category: "governance-stop", count: governanceStops }],
      readEvidence: {
        unchangedReReads,
        withheld: unchangedReReads === 0 ? 0 : 1,
        maxRepeatsOfOneResult: unchangedReReads,
        ...(deniedAfterAsk === undefined ? {} : { deniedAfterAsk }),
      },
    });
    expect(decodeTools(tools(3, 3)).readEvidence?.deniedAfterAsk).toBe(3);
    expect(decodeTools(tools(undefined, 3)).readEvidence).not.toHaveProperty("deniedAfterAsk");
    // Denied calls with no unchanged re-read: the ask came from the elapsed share.
    expect(decodeTools(tools(2, 2, 0)).readEvidence?.deniedAfterAsk).toBe(2);
    // More denied calls than governance stops, a zero, or nothing at all is refused.
    expect(() => decodeTools(tools(4, 3))).toThrow();
    expect(() => decodeTools(tools(0, 3))).toThrow();
    expect(() => decodeTools(tools(undefined, 3, 0))).toThrow();
  });

  it("always delivers changed content in full, as a new result with its own count", async () => {
    const files = new Map([["docs/guide.md", "v1"]]);
    const target = ledger();
    const tool = readTool(files, target);
    await tool.execute("a", { path: "docs/guide.md" });
    await tool.execute("b", { path: "docs/guide.md" });
    await tool.execute("c", { path: "docs/guide.md" });
    expect(target.counters().worstRepeats).toBe(2);
    files.set("docs/guide.md", "v2");
    const changed = await tool.execute("d", { path: "docs/guide.md" });
    expect(changed.content).toEqual(text("v2"));
    expect(target.takeClassification("d")).toBe("new-evidence");
    const again = await tool.execute("e", { path: "docs/guide.md" });
    expect(again.content[0]).toEqual({ type: "text", text: "v2" });
    expect(again.content[1]?.text).toContain("(re-read 1 times;");
  });

  it("always delivers a range not yet delivered, even of the same file", async () => {
    const target = ledger();
    const tool = readTool(new Map([["a.md", "one\ntwo\nthree"]]), target);
    await tool.execute("a", { path: "a.md" });
    await tool.execute("b", { path: "a.md" });
    await tool.execute("c", { path: "a.md" });
    const range = await tool.execute("d", { path: "a.md", offset: 2 });
    expect(range.content).toEqual(text("two\nthree"));
    expect(target.takeClassification("d")).toBe("new-evidence");
  });

  it("delivers distinct files in full however many there are", async () => {
    const files = new Map(Array.from({ length: 12 }, (_, i) => [`f${i}.md`, `body ${i}`]));
    const target = ledger();
    const tool = readTool(files, target);
    for (const path of files.keys()) {
      const result = await tool.execute(path, { path });
      expect(result.content).toEqual(text(files.get(path)!));
    }
    expect(target.counters()).toMatchObject({ worstRepeats: 0, repeats: 0, withheld: 0 });
  });

  it("re-delivers in full after a compaction starts a new epoch", async () => {
    const target = ledger();
    const tool = readTool(new Map([["a.md", "alpha"]]), target);
    for (const id of ["a", "b", "c", "d"]) await tool.execute(id, { path: "a.md" });
    expect(target.takeClassification("d")).toBe("withheld");
    target.startEpoch();
    const after = await tool.execute("e", { path: "a.md" });
    expect(after.content).toEqual(text("alpha"));
    expect(target.takeClassification("e")).toBe("new-evidence");
    expect(target.counters()).toMatchObject({ epoch: 2, worstRepeats: 0 });
  });

  it("lets a new progress-class call reset the counts, and a neutral call not", async () => {
    const target = ledger();
    const tool = readTool(new Map([["a.md", "alpha"]]), target);
    const claim = withReadEvidence(
      { name: "canon_propose_claim", execute: async () => ({ content: text("ok") }) },
      target,
    );
    const query = withReadEvidence(
      { name: "canon_query", execute: async () => ({ content: text("q") }) },
      target,
    );
    await tool.execute("a", { path: "a.md" });
    await tool.execute("b", { path: "a.md" });
    await query.execute("q1", {});
    await tool.execute("c", { path: "a.md" });
    expect(target.counters().worstRepeats).toBe(2);
    expect(target.takeClassification("q1")).toBeUndefined();
    await claim.execute("p1", { claim: "one" });
    expect(target.takeClassification("p1")).toBe("progress");
    expect(target.counters().worstRepeats).toBe(0);
    const next = await tool.execute("d", { path: "a.md" });
    expect(next.content[0]).toEqual({ type: "text", text: "alpha" });
    expect(target.takeClassification("d")).toBe("repeat");
  });

  it("admits only new evidence, new progress and neutral successes as lease progress", () => {
    expect(isUsefulProgress("new-evidence")).toBe(true);
    expect(isUsefulProgress("progress")).toBe(true);
    expect(isUsefulProgress(undefined)).toBe(true);
    expect(isUsefulProgress("repeat")).toBe(false);
    expect(isUsefulProgress("withheld")).toBe(false);
    expect(isUsefulProgress("repeated-progress")).toBe(false);
  });

  it("does not count an identical repeated proposal as progress", async () => {
    const target = ledger();
    const tool = readTool(new Map([["a.md", "alpha"]]), target);
    const claim = withReadEvidence(
      { name: "canon_propose_claim", execute: async () => ({ content: text("ok") }) },
      target,
    );
    await tool.execute("a", { path: "a.md" });
    await claim.execute("p1", { claim: "same" });
    expect(target.takeClassification("p1")).toBe("progress");
    // Read, re-propose the identical claim, read again: the loop keeps counting.
    for (let index = 1; index <= 5; index += 1) {
      await tool.execute(`r${index}`, { path: "a.md" });
      await claim.execute(`p${index + 1}`, { claim: "same" });
      expect(target.takeClassification(`p${index + 1}`)).toBe("repeated-progress");
    }
    expect(target.counters().worstRepeats).toBe(5);
    expect(target.stopDue).toBe(true);
    // A different proposal is progress again.
    await claim.execute("p9", { claim: "different" });
    expect(target.takeClassification("p9")).toBe("progress");
    expect(target.stopDue).toBe(false);
  });

  it("lets a verification pass re-read unchanged files in full up to the cross-result allowance", async () => {
    const files = new Map(Array.from({ length: 6 }, (_, i) => [`f${i}.md`, `body ${i}`]));
    const target = ledger();
    const tool = readTool(files, target);
    for (const path of files.keys()) await tool.execute(`first-${path}`, { path });
    // One pass over all 6 files: 6 unchanged re-reads, exactly the allowance.
    for (const path of files.keys()) {
      const result = await tool.execute(`pass-${path}`, { path });
      expect(result.content[0]).toEqual({ type: "text", text: files.get(path) });
      expect(target.takeClassification(`pass-${path}`)).toBe("repeat");
    }
    expect(target.counters()).toMatchObject({
      worstRepeats: 1,
      acrossResults: 6,
      repeats: 6,
      withheld: 0,
    });
    expect(target.noticeOnlyAnswers).toBe(0);
    expect(target.stopDue).toBe(false);
  });

  it("stops a cycle over several results by the cross-result code, none of them re-read often", async () => {
    const files = new Map(Array.from({ length: 4 }, (_, i) => [`f${i}.md`, `body ${i}`]));
    const target = ledger(3);
    const tool = readTool(files, target);
    for (const path of files.keys()) await tool.execute(`first-${path}`, { path });
    const cycle = [...files.keys()];
    const read = async (index: number) => {
      const path = cycle[index % cycle.length]!;
      return tool.execute(`r${index}`, { path });
    };
    // Re-reads 1-6 stay within the allowance, but re-read 3 of one file is past
    // its own streak of 2, so the per-result bound withholds it first.
    for (let index = 0; index < 6; index += 1) await read(index);
    expect(target.counters()).toMatchObject({ worstRepeats: 2, acrossResults: 6, withheld: 0 });
    // Re-read 7 is past the allowance of 6 although its file is at 2 re-reads.
    const seventh = await read(6);
    expect(target.takeClassification("r6")).toBe("withheld");
    expect(bodyOf(seventh)).toContain(
      "This attempt has re-read 7 unchanged results with no progress between; past 6 the host sends only this notice.",
    );
    expect(bodyOf(seventh)).toContain(
      "2 more notice-only answers end this attempt as no-progress.",
    );
    await read(7);
    expect(target.stopDue).toBe(false);
    await read(8);
    expect(target.counters()).toMatchObject({ worstRepeats: 3, acrossResults: 9, withheld: 3 });
    expect(target.withheldOfWorst).toBe(1);
    expect(target.withheldAcrossResults).toBe(3);
    expect(target.stopBound).toBe("across-results");
    expect(target.stopDue).toBe(true);
    expect(target.stopRejection()).toEqual({
      code: "execution-read-loop-unchanged-re-reads-bound",
      location: "$.tools",
    });
    expect(target.stopMessage()).toBe(
      "execution-read-loop-unchanged-re-reads-bound: 9 exceeds execution.readLoopUnchangedReReads = 6 count. The step cycled through results it had already read instead of finishing. Retry the step (the correction policy decides), narrow its scope, or raise DOCSFAB_EXECUTION_READ_LOOP_UNCHANGED_RE_READS (up to 400). Follow the named remediation. Read loop across results in this step attempt: 9 unchanged re-reads with no progress call between, at most 3 of one result; the host answered the last 3 with a notice only, and the notice-only allowance is execution.readLoopWithheldReads = 2.",
    );
    expect(target.snapshot()).toEqual({
      unchangedReReads: 9,
      withheld: 3,
      maxRepeatsOfOneResult: 3,
      maxUnchangedReReadsAcrossResults: 9,
    });
  });

  it("keeps a pure one-result loop on its own code, and charges a mixed loop to the bound that withheld more", async () => {
    const files = new Map([
      ["hot.md", "hot"],
      ...Array.from({ length: 4 }, (_, i) => [`f${i}.md`, `body ${i}`] as [string, string]),
    ]);
    const pure = ledger();
    const pureTool = readTool(files, pure);
    for (let index = 0; index < 6; index += 1)
      await pureTool.execute(`h${index}`, { path: "hot.md" });
    // 5 re-reads of one result: 3 past its streak, 0 past the cross-result allowance.
    expect(pure.stopBound).toBe("one-result");
    expect(pure.stopRejection().code).toBe("execution-read-loop-withheld-reads-bound");

    const mixed = ledger(1, {
      environment: {
        DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "2",
        DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "4",
        DOCSFAB_EXECUTION_READ_LOOP_UNCHANGED_RE_READS: "3",
      },
    });
    const tool = readTool(files, mixed);
    for (const path of files.keys()) await tool.execute(`first-${path}`, { path });
    for (let index = 0; index < 4; index += 1)
      await tool.execute(`hot${index}`, { path: "hot.md" });
    for (let index = 0; index < 4; index += 1) {
      await tool.execute(`other${index}`, { path: `f${index}.md` });
    }
    // hot.md: 4 re-reads, 2 past its streak; all results: 8 re-reads, 5 past 3.
    expect(mixed.withheldOfWorst).toBe(2);
    expect(mixed.withheldAcrossResults).toBe(5);
    expect(mixed.stopBound).toBe("across-results");
    expect(mixed.stopDue).toBe(true);
    expect(mixed.stopRejection().code).toBe("execution-read-loop-unchanged-re-reads-bound");
  });

  it("charges notice-only answers to the larger bound once, never to both summed", async () => {
    const files = new Map([["hot.md", "hot"]]);
    const both = ledger(1, {
      environment: {
        DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "2",
        DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "2",
        DOCSFAB_EXECUTION_READ_LOOP_UNCHANGED_RE_READS: "3",
      },
    });
    const tool = readTool(files, both);
    for (let index = 0; index < 5; index += 1) await tool.execute(`h${index}`, { path: "hot.md" });
    // 4 re-reads of one result: 2 past its streak and 1 past the cross-result
    // allowance. The same answers are counted once: 2, not 3, so no stop yet.
    expect([both.withheldOfWorst, both.withheldAcrossResults]).toEqual([2, 1]);
    expect(both.noticeOnlyAnswers).toBe(2);
    expect(both.stopDue).toBe(false);
    await tool.execute("h5", { path: "hot.md" });
    expect(both.noticeOnlyAnswers).toBe(3);
    expect(both.stopDue).toBe(true);
  });

  it("resets the cross-result count on a new progress call, not on a compaction", async () => {
    const files = new Map(Array.from({ length: 4 }, (_, i) => [`f${i}.md`, `body ${i}`]));
    const target = ledger();
    const tool = readTool(files, target);
    const write = withReadEvidence(
      { name: "write", execute: async () => ({ content: text("written") }) },
      target,
    );
    for (const path of files.keys()) await tool.execute(`first-${path}`, { path });
    for (const path of files.keys()) await tool.execute(`again-${path}`, { path });
    expect(target.counters().acrossResults).toBe(4);
    // A compaction: re-reads after it are new evidence and add nothing, and
    // the count of re-reads the model did see twice is kept.
    target.startEpoch();
    for (const path of files.keys()) {
      await tool.execute(`epoch-${path}`, { path });
      expect(target.takeClassification(`epoch-${path}`)).toBe("new-evidence");
    }
    expect(target.counters()).toMatchObject({ acrossResults: 4, worstRepeats: 0 });
    await tool.execute("again2-f0.md", { path: "f0.md" });
    expect(target.counters().acrossResults).toBe(5);
    await write.execute("w1", { path: "out.md", content: "x" });
    expect(target.counters()).toMatchObject({ acrossResults: 0, worstRepeats: 0 });
    // The peak survives the reset, for the record.
    expect(target.snapshot()?.maxUnchangedReReadsAcrossResults).toBe(5);
  });

  it("keeps counting one result re-read in a loop that interleaves new reads", async () => {
    const files = new Map(Array.from({ length: 10 }, (_, i) => [`f${i}.md`, `body ${i}`]));
    files.set("guide.md", "guide");
    const target = ledger();
    const tool = readTool(files, target);
    await tool.execute("g0", { path: "guide.md" });
    for (let index = 0; index < 5; index += 1) {
      await tool.execute(`n${index}`, { path: `f${index}.md` });
      await tool.execute(`g${index + 1}`, { path: "guide.md" });
    }
    expect(target.counters().worstRepeats).toBe(5);
    expect(target.stopDue).toBe(true);
  });

  it("keeps a failed read neutral: no classification and no count change", async () => {
    const target = ledger();
    const tool = readTool(new Map([["a.md", "alpha"]]), target);
    await tool.execute("a", { path: "a.md" });
    await tool.execute("b", { path: "a.md" });
    await expect(tool.execute("x", { path: "missing.md" })).rejects.toThrow("ENOENT: missing.md");
    expect(target.takeClassification("x")).toBeUndefined();
    expect(target.counters().worstRepeats).toBe(1);
  });

  it("never judges an unfingerprintable argument a repeat", async () => {
    const target = ledger();
    const tool = withReadEvidence(
      { name: "ls", execute: async () => ({ content: text("a.md") }) },
      target,
    );
    const odd = { path: ".", when: new Date(0) };
    for (const id of ["a", "b", "c", "d"]) {
      const result = await tool.execute(id, odd);
      expect(result.content).toEqual(text("a.md"));
      expect(target.takeClassification(id)).toBe("new-evidence");
    }
  });

  it("judges an image block too: a changed image under unchanged text is new evidence", async () => {
    const target = ledger();
    let data = "aW1hZ2Ux";
    const tool = withReadEvidence(
      {
        name: "read",
        execute: async () => ({
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data, mimeType: "image/png" },
          ],
        }),
      },
      target,
    );
    await tool.execute("a", { path: "chart.png" });
    await tool.execute("b", { path: "chart.png" });
    expect(target.takeClassification("b")).toBe("repeat");
    data = "aW1hZ2Uy";
    const changed = await tool.execute("c", { path: "chart.png" });
    expect(target.takeClassification("c")).toBe("new-evidence");
    expect(changed.content[1]).toEqual({ type: "image", data, mimeType: "image/png" });
  });

  it("keeps counting a read loop that interleaves a neutral canon query", async () => {
    const target = ledger();
    const tool = readTool(new Map([["a.md", "alpha"]]), target);
    const query = withReadEvidence(
      { name: "canon_query", execute: async () => ({ content: text("same answer") }) },
      target,
    );
    await tool.execute("r0", { path: "a.md" });
    for (let index = 1; index <= 5; index += 1) {
      await query.execute(`q${index}`, { query: "routing" });
      await tool.execute(`r${index}`, { path: "a.md" });
    }
    expect(target.counters().worstRepeats).toBe(5);
    expect(target.stopDue).toBe(true);
  });

  it("names the bound's catalog code as the attempt's failure code", () => {
    const target = ledger();
    expect(target.stopRejection()).toEqual({
      code: "execution-read-loop-withheld-reads-bound",
      location: "$.tools",
    });
    const classified = classifyInferenceAttempt({
      attempt: 1,
      outcome: "no-progress",
      retryable: false,
      retryScheduled: false,
      durationMs: 1,
      rejection: target.stopRejection(),
    });
    expect(classified).toMatchObject({
      layer: "inference",
      code: "execution-read-loop-withheld-reads-bound",
    });
  });

  it("never records a result the credential screen refused as delivered", async () => {
    configureCredential(`${"glpat-"}${"a".repeat(24)}`);
    const root = await temporaryDirectories.create("docsfab-read-evidence-");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "docs"), { recursive: true });
    // Synthetic, never-real token shape.
    await writeFile(join(workspace, "docs", "shaped.md"), `token ${"glpat-"}${"a".repeat(24)}\n`);
    await writeFile(join(workspace, "docs", "clean.md"), "clean\n");
    const target = ledger();
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      readEvidence: target,
    });
    const read = toolSet.definitions.find((definition) => definition.name === "read")!;
    const call = (id: string, path: string) =>
      read.execute(id, { path }, undefined, undefined, undefined as never);
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await expect(call(id, "docs/shaped.md")).rejects.toThrow("credential-isolation boundary");
      expect(target.takeClassification(id)).toBeUndefined();
    }
    expect(target.counters()).toMatchObject({ worstRepeats: 0, repeats: 0 });
    // A file name in a listing that holds a configured credential is refused the same way.
    await mkdir(join(workspace, "listing"), { recursive: true });
    const listed = configureCredential(`${"glpat-"}${"b".repeat(24)}`);
    await writeFile(join(workspace, "listing", `${listed}.md`), "x\n");
    const ls = toolSet.definitions.find((definition) => definition.name === "ls")!;
    for (const id of ["l1", "l2", "l3"]) {
      await expect(
        ls.execute(id, { path: "listing" }, undefined, undefined, undefined as never),
      ).rejects.toThrow("credential-isolation boundary");
      expect(target.takeClassification(id)).toBeUndefined();
    }
    expect(target.counters()).toMatchObject({ worstRepeats: 0, repeats: 0 });
    // Positive control: the shipped tool set does feed the ledger.
    await call("c1", "docs/clean.md");
    await call("c2", "docs/clean.md");
    expect(target.takeClassification("c2")).toBe("repeat");
  });

  it("decodes only consistent read-evidence counters on a tool summary", () => {
    const summary = (readEvidence: unknown) => ({
      totalCalls: 6,
      failedCalls: 0,
      byTool: [{ name: "read", calls: 6, failures: 0 }],
      readEvidence,
    });
    const counters = { unchangedReReads: 5, withheld: 3, maxRepeatsOfOneResult: 3 };
    expect(decodeTools(summary(counters)).readEvidence).toEqual(counters);
    const across = { ...counters, maxUnchangedReReadsAcrossResults: 4 };
    expect(decodeTools(summary(across)).readEvidence).toEqual(across);
    // Both edges: one result's re-reads, and every re-read of the attempt.
    for (const edge of [3, 5]) {
      const value = { ...counters, maxUnchangedReReadsAcrossResults: edge };
      expect(decodeTools(summary(value)).readEvidence).toEqual(value);
    }
    for (const invalid of [
      { ...counters, maxUnchangedReReadsAcrossResults: 2 },
      { ...counters, maxUnchangedReReadsAcrossResults: 6 },
      { ...counters, maxUnchangedReReadsAcrossResults: -1 },
      { ...counters, withheld: 6 },
      { ...counters, maxRepeatsOfOneResult: 6 },
      { ...counters, unchangedReReads: 7, maxRepeatsOfOneResult: 7 },
      { ...counters, unchangedReReads: 0, withheld: 0, maxRepeatsOfOneResult: 0 },
      { ...counters, path: "docs/guide.md" },
    ]) {
      expect(() => decodeTools(summary(invalid)), JSON.stringify(invalid)).toThrow(
        /rejected|invalid/iu,
      );
    }
  });

  it("never records a source-tool result the outer result screen refused", async () => {
    const root = await temporaryDirectories.create("docsfab-read-evidence-source-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    // Synthetic, never-real token shape, only in the listing's path field. The
    // source tools have no path screen of their own, so only the outermost
    // result screen refuses it.
    const shapedPath = `docs/${configureCredential(`${"glpat-"}${"c".repeat(24)}`)}.md`;
    let listing = shapedPath;
    const sourceReader = {
      listSources: () => [
        {
          observationId: "obs-1",
          representationId: "rep-1",
          repositoryPath: listing,
          mediaType: "text/markdown",
          spanId: "span-1",
          startByte: 0,
          endByte: 1,
          locator: { kind: "byte-range" },
        },
      ],
      read: () => {
        throw new Error("not used");
      },
    };
    const target = ledger();
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      readEvidence: target,
      sourceReader: sourceReader as never,
    });
    const list = toolSet.definitions.find(
      (definition) => definition.name === "docsfab_list_sources",
    )!;
    const call = (id: string) => list.execute(id, {}, undefined, undefined, undefined as never);
    for (const id of ["s1", "s2", "s3"]) {
      await expect(call(id)).rejects.toThrow("credential-isolation boundary");
      expect(target.takeClassification(id)).toBeUndefined();
    }
    expect(target.counters()).toMatchObject({ worstRepeats: 0, repeats: 0 });
    // Positive control: a clean listing feeds the ledger.
    listing = "docs/clean.md";
    await call("c1");
    await call("c2");
    expect(target.takeClassification("c2")).toBe("repeat");
  });
});
