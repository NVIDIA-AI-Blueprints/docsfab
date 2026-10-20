// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { limit, limitDefinition } from "../src/config/limits.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import {
  REVIEW_CHANGE_READ_TOOL_NAME,
  REVIEW_CHANGE_SELECT_TOOL_NAME,
  type ReviewChangeSource,
} from "../src/harness/confined-tools/review-change-side.js";
import {
  READ_EVIDENCE_NOTICE_PREFIX,
  ReadEvidenceLedger,
  resolveReadLoopPolicy,
} from "../src/harness/read-evidence.js";
import { SOURCE_LIST_MAX_ENTRIES } from "../src/harness/source-tools.js";
import { temporaryRoots } from "./helpers/temp.js";
import { configureCredential } from "./helpers/configured-credential.js";

const roots = temporaryRoots();
const identity = "a".repeat(64);
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sideBytes = [Buffer.from("same text\n"), Buffer.from("second line\n")];
const sideRawSha256 = sha256(Buffer.concat(sideBytes));
const reference: ReviewChangeSource["reference"] = {
  kind: "docsfab-review-delivery-snapshot-reference",
  schemaVersion: 1,
  runId: "side-run",
  rootObjectSha256: identity,
  snapshotSha256: identity,
  changeSourceSha256: identity,
  reviewedHeadSha: "b".repeat(40),
  repositoryIdentitySha256: identity,
};

function source(): ReviewChangeSource {
  return {
    reference,
    listFiles: () => [
      {
        fileOrdinal: 0,
        oldPath: "docs/deleted.md",
        newPath: null,
        beforeAvailable: true,
        afterAvailable: false,
      },
      {
        fileOrdinal: 1,
        oldPath: "docs/old.md",
        newPath: "docs/new.md",
        beforeAvailable: true,
        afterAvailable: true,
      },
    ],
    readSide: (fileOrdinal, side) => {
      if (fileOrdinal === 0 && side === "before")
        return {
          fileOrdinal,
          side,
          oldPath: "docs/deleted.md",
          newPath: null,
          blob: "c".repeat(40),
          rawSha256: sideRawSha256,
          lines: ["same text", "second line"],
          lineBytes: sideBytes,
        };
      if (fileOrdinal === 1)
        return {
          fileOrdinal,
          side,
          oldPath: "docs/old.md",
          newPath: "docs/new.md",
          blob: side === "before" ? "d".repeat(40) : "e".repeat(40),
          rawSha256: sideRawSha256,
          lines: ["same text", "second line"],
          lineBytes: sideBytes,
        };
      return undefined;
    },
  };
}

async function fixture(
  options: {
    readonly cap?: number;
    readonly maxObjectBytes?: number;
    readonly sourceCapability?: ReviewChangeSource;
  } = {},
) {
  const root = await roots.create("docsfab-review-side-tool-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "head.md"), "after-side workspace text\n");
  await mkdir(join(workspace, "docs"));
  await writeFile(join(workspace, "docs/new.md"), Buffer.concat(sideBytes));
  const readEvidence = new ReadEvidenceLedger(
    resolveReadLoopPolicy({
      environment: {
        DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "1",
        DOCSFAB_EXECUTION_READ_LOOP_UNCHANGED_RE_READS: "1",
      },
    }),
  );
  const set = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: false,
    readTextRendering: "source-coordinates",
    reviewChangeSource: options.sourceCapability ?? source(),
    reviewChangeRunId: "side-run",
    reviewChangeStepId: "verify-technical-accuracy",
    reviewReadMaxObjectBytes: options.maxObjectBytes ?? limit("artifacts.maxObjectBytes").value,
    readEvidence,
    ...(options.cap === undefined ? {} : { toolOutputCapBytes: options.cap }),
  });
  const call = async (name: string, id: string, params: Record<string, unknown>) => {
    const tool = set.definitions.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(id, params, undefined, undefined, undefined as never) as Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
  return { set, call, readEvidence };
}

const before = { fileOrdinal: 0, side: "before", startLine: 1, endLine: 2 };
const proposed = { originalIssueId: "TECH-DEL", ...before };
const text = (value: { content: Array<{ text?: string }> }) =>
  value.content.map((part) => part.text ?? "").join("");

describe("pinned review side tool", () => {
  it("uses one sealed catalog page limit for source and review-side inventories", async () => {
    expect(limitDefinition("sources.listMaxEntries")).toMatchObject({
      value: SOURCE_LIST_MAX_ENTRIES,
      scope: "sealed",
      override: null,
    });
    const { call } = await fixture();
    await expect(
      call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-over-limit", {
        maxFiles: SOURCE_LIST_MAX_ENTRIES + 1,
      }),
    ).rejects.toThrow(
      `sources-list-max-entries-bound: ${SOURCE_LIST_MAX_ENTRIES + 1} exceeds ` +
        `sources.listMaxEntries = ${SOURCE_LIST_MAX_ENTRIES} count`,
    );
  });

  it("pages available sides without minting line evidence or resetting the outer read loop", async () => {
    const { set, call, readEvidence } = await fixture();
    const defaultPage = JSON.parse(
      text(await call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-default", {})),
    );
    expect(defaultPage).toMatchObject({
      fileCount: 2,
      fromFileOrdinal: 0,
      nextFileOrdinal: null,
      files: [{ fileOrdinal: 0 }, { fileOrdinal: 1 }],
    });
    const first = JSON.parse(
      text(
        await call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-first", {
          maxFiles: 1,
        }),
      ),
    );
    expect(first).toMatchObject({
      fileCount: 2,
      fromFileOrdinal: 0,
      nextFileOrdinal: 1,
      files: [
        {
          fileOrdinal: 0,
          oldPath: "docs/deleted.md",
          newPath: null,
          beforeAvailable: true,
          afterAvailable: false,
        },
      ],
    });
    const second = JSON.parse(
      text(
        await call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-next", {
          fromFileOrdinal: first.nextFileOrdinal,
          maxFiles: 1,
        }),
      ),
    );
    expect(second).toMatchObject({
      fromFileOrdinal: 1,
      nextFileOrdinal: null,
      files: [
        {
          fileOrdinal: 1,
          oldPath: "docs/old.md",
          newPath: "docs/new.md",
          beforeAvailable: true,
          afterAvailable: true,
        },
      ],
    });
    const end = JSON.parse(
      text(
        await call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-end", {
          fromFileOrdinal: 2,
        }),
      ),
    );
    expect(end).toMatchObject({ fileCount: 2, files: [], nextFileOrdinal: null });
    expect(set.getReviewChangeObservation()?.delivered).toEqual([]);
    await expect(
      call(REVIEW_CHANGE_SELECT_TOOL_NAME, "inventory-only-select", proposed),
    ).rejects.toThrow("not fully delivered");
    await expect(
      call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-invalid", {
        fromFileOrdinal: 3,
      }),
    ).rejects.toThrow("inventory cursor");
    await expect(
      call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-page-invalid", {
        maxFiles: 0,
      }),
    ).rejects.toThrow("inventory cursor");
    await expect(
      call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-mixed", {
        fromFileOrdinal: 0,
        ...before,
      }),
    ).rejects.toThrow("range arguments");
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "line-first", before);
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "line-repeat-one", before);
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-between", { fromFileOrdinal: 1 });
    const withheld = await call(REVIEW_CHANGE_READ_TOOL_NAME, "line-repeat-two", before);
    expect(text(withheld)).toContain(READ_EVIDENCE_NOTICE_PREFIX);
    expect(readEvidence.snapshot()?.withheld).toBeGreaterThan(0);
    expect(set.getReviewChangeObservation()?.delivered).toHaveLength(1);
  });

  it("lists an empty authenticated change source with no guessed ordinal", async () => {
    const empty = await fixture({
      sourceCapability: {
        reference,
        listFiles: () => [],
        readSide: () => undefined,
      },
    });
    expect(
      JSON.parse(text(await empty.call(REVIEW_CHANGE_READ_TOOL_NAME, "empty", {}))),
    ).toMatchObject({ fileCount: 0, fromFileOrdinal: 0, nextFileOrdinal: null, files: [] });
    expect(empty.set.getReviewChangeObservation()?.delivered).toEqual([]);
  });

  it("retains a capped inventory page for replay from the same cursor", async () => {
    const capped = await fixture({ cap: 256 });
    const over = await capped.call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-over-cap", {
      fromFileOrdinal: 0,
      maxFiles: 2,
    });
    expect(text(over)).toContain("docsfab-output-cap");
    const first = JSON.parse(
      text(
        await capped.call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-retry", {
          fromFileOrdinal: 0,
          maxFiles: 1,
        }),
      ),
    );
    expect(first).toMatchObject({
      fromFileOrdinal: 0,
      nextFileOrdinal: 1,
      files: [{ fileOrdinal: 0 }],
    });
    const second = JSON.parse(
      text(
        await capped.call(REVIEW_CHANGE_READ_TOOL_NAME, "inventory-continue", {
          fromFileOrdinal: first.nextFileOrdinal,
          maxFiles: 1,
        }),
      ),
    );
    expect(second).toMatchObject({
      fromFileOrdinal: 1,
      nextFileOrdinal: null,
      files: [{ fileOrdinal: 1 }],
    });
    expect(capped.set.getReviewChangeObservation()?.delivered).toEqual([]);
  });

  it("keeps proposal calls neutral while the real read wrapper withholds repeated bytes", async () => {
    const { set, call, readEvidence } = await fixture();
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "neutral-first", before);
    await call(REVIEW_CHANGE_SELECT_TOOL_NAME, "neutral-proposal-one", {
      ...proposed,
      originalIssueId: "TECH-ONE",
    });
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "neutral-repeat-one", before);
    await call(REVIEW_CHANGE_SELECT_TOOL_NAME, "neutral-proposal-two", {
      ...proposed,
      originalIssueId: "TECH-TWO",
    });
    const withheld = await call(REVIEW_CHANGE_READ_TOOL_NAME, "neutral-repeat-two", before);
    expect(text(withheld)).toContain(READ_EVIDENCE_NOTICE_PREFIX);
    expect(readEvidence.snapshot()?.withheld).toBeGreaterThan(0);
    expect(set.getReviewChangeObservation()?.delivered).toHaveLength(1);
    expect(set.getReviewChangeObservation()?.proposals).toHaveLength(2);
  });

  it("binds deletion and rename sides even when the same text appears on both", async () => {
    const { set, call } = await fixture();
    await expect(call(REVIEW_CHANGE_SELECT_TOOL_NAME, "early", proposed)).rejects.toThrow(
      "not fully delivered",
    );
    const deleted = await call(REVIEW_CHANGE_READ_TOOL_NAME, "read-deleted", before);
    expect(text(deleted)).toContain('"oldPath":"docs/deleted.md","newPath":null');
    expect(text(deleted)).toContain("[source-line 1] same text\n[source-line 2] second line\n");
    await call(REVIEW_CHANGE_SELECT_TOOL_NAME, "select-deleted", proposed);
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "read-renamed-before", {
      fileOrdinal: 1,
      side: "before",
      startLine: 1,
      endLine: 1,
    });
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "read-renamed-after", {
      fileOrdinal: 1,
      side: "after",
      startLine: 1,
      endLine: 1,
    });
    const observed = set.getReviewChangeObservation()!;
    expect(observed.proposals).toMatchObject([
      {
        originalIssueId: "TECH-DEL",
        fileOrdinal: 0,
        side: "before",
        oldPath: "docs/deleted.md",
        newPath: null,
        startLine: 1,
        endLine: 2,
      },
    ]);
    expect(
      observed.delivered.filter((entry) => entry.fileOrdinal === 1).map((entry) => entry.blob),
    ).toEqual(["d".repeat(40), "e".repeat(40)]);
    await expect(
      call(REVIEW_CHANGE_READ_TOOL_NAME, "missing", {
        fileOrdinal: 0,
        side: "after",
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow("unavailable");
    const afterWorkspace = await call("read", "head-read", { path: "head.md" });
    expect(text(afterWorkspace)).toContain("[source-line 1] after-side workspace text");
    expect(set.getReviewReadObservation()?.files[0]?.lines).toMatchObject([{ line: 1 }]);
  });

  it("selects a pinned after range shown by the existing workspace read without a side-tool read", async () => {
    const { set, call } = await fixture();
    await expect(
      call(REVIEW_CHANGE_SELECT_TOOL_NAME, "unseen-after", {
        originalIssueId: "TECH-AFTER",
        fileOrdinal: 1,
        side: "after",
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow("not fully delivered");
    const workspace = await call("read", "workspace-after", { path: "docs/new.md" });
    expect(text(workspace)).toContain("[source-line 1] same text");
    await call(REVIEW_CHANGE_SELECT_TOOL_NAME, "observed-after", {
      originalIssueId: "TECH-AFTER",
      fileOrdinal: 1,
      side: "after",
      startLine: 1,
      endLine: 1,
    });
    expect(set.getReviewChangeObservation()).toMatchObject({
      delivered: [{ fileOrdinal: 1, side: "after", startLine: 1, endLine: 1 }],
      proposals: [{ originalIssueId: "TECH-AFTER", fileOrdinal: 1, side: "after" }],
    });
    const pinned = source();
    const mismatched = await fixture({
      sourceCapability: {
        ...pinned,
        readSide: (ordinal, side) => {
          const admitted = pinned.readSide(ordinal, side);
          return admitted && ordinal === 1 && side === "after"
            ? { ...admitted, rawSha256: identity }
            : admitted;
        },
      },
    });
    await mismatched.call("read", "mismatched-workspace", { path: "docs/new.md" });
    await expect(
      mismatched.call(REVIEW_CHANGE_SELECT_TOOL_NAME, "mismatched-after", {
        originalIssueId: "TECH-AFTER",
        fileOrdinal: 1,
        side: "after",
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow("not fully delivered");
  });

  it("hashes exact selected LF, CRLF, and unterminated source bytes", async () => {
    const pinned = source();
    const rows = new Map<number, Buffer[]>([
      [2, [Buffer.from("one\n"), Buffer.from("two\n")]],
      [3, [Buffer.from("one\r\n"), Buffer.from("two")]],
    ]);
    const selected = await fixture({
      sourceCapability: {
        ...pinned,
        readSide: (ordinal, side) => {
          const lineBytes = rows.get(ordinal);
          if (!lineBytes || side !== "before") return undefined;
          return {
            fileOrdinal: ordinal,
            side,
            oldPath: `docs/${ordinal}.md`,
            newPath: null,
            blob: "f".repeat(40),
            rawSha256: sha256(Buffer.concat(lineBytes)),
            lines: lineBytes.map((row) => row.toString("utf8").replace(/\n$/u, "")),
            lineBytes,
          };
        },
      },
    });
    for (const ordinal of rows.keys()) {
      const read = await selected.call(REVIEW_CHANGE_READ_TOOL_NAME, `terminator-${ordinal}`, {
        fileOrdinal: ordinal,
        side: "before",
        startLine: 1,
        endLine: 2,
      });
      expect(text(read).endsWith(ordinal === 2 ? "two\n" : "two")).toBe(true);
      await selected.call(REVIEW_CHANGE_SELECT_TOOL_NAME, `select-${ordinal}`, {
        originalIssueId: `TECH-${ordinal}`,
        fileOrdinal: ordinal,
        side: "before",
        startLine: 1,
        endLine: 2,
      });
      expect(selected.set.getReviewChangeObservation()?.proposals.at(-1)?.rangeSha256).toBe(
        sha256(Buffer.concat(rows.get(ordinal)!)),
      );
    }
    expect(selected.set.getReviewChangeObservation()?.proposals[0]?.rangeSha256).not.toBe(
      selected.set.getReviewChangeObservation()?.proposals[1]?.rangeSha256,
    );
  });

  it("keeps earlier evidence after notice-only repeat and refuses forged or conflicting proposals", async () => {
    const { set, call } = await fixture();
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "first", before);
    await call(REVIEW_CHANGE_READ_TOOL_NAME, "repeat-one", before);
    const withheld = await call(REVIEW_CHANGE_READ_TOOL_NAME, "repeat-two", before);
    expect(text(withheld)).toContain(READ_EVIDENCE_NOTICE_PREFIX);
    expect(set.getReviewChangeObservation()?.delivered).toHaveLength(1);
    await expect(
      call(REVIEW_CHANGE_SELECT_TOOL_NAME, "forged", {
        originalIssueId: "TECH-FORGED",
        fileOrdinal: 1,
        side: "before",
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow("not fully delivered");
    await call(REVIEW_CHANGE_SELECT_TOOL_NAME, "valid", proposed);
    await expect(
      call(REVIEW_CHANGE_SELECT_TOOL_NAME, "conflict", {
        ...proposed,
        endLine: 1,
      }),
    ).rejects.toThrow("conflicting");
    expect(set.getReviewChangeObservation()).toMatchObject({
      proposals: [],
      conflictingIssueIds: ["TECH-DEL"],
      delivered: [{ fileOrdinal: 0, side: "before" }],
    });
  });

  it("never records capped partial rows and refuses an artifact limit-plus-one", async () => {
    const capped = await fixture({ cap: 64 });
    const result = await capped.call(REVIEW_CHANGE_READ_TOOL_NAME, "clipped", before);
    expect(text(result)).toContain("docsfab-output-cap");
    expect(capped.set.getReviewChangeObservation()?.delivered).toEqual([]);
    await expect(capped.call(REVIEW_CHANGE_SELECT_TOOL_NAME, "bad", proposed)).rejects.toThrow(
      "not fully delivered",
    );
    const defaultSize = await fixture();
    await defaultSize.call(REVIEW_CHANGE_READ_TOOL_NAME, "whole", before);
    const serialized = Buffer.byteLength(
      JSON.stringify(defaultSize.set.getReviewChangeObservation()),
    );
    const smaller = await fixture({ maxObjectBytes: serialized - 1 });
    await expect(smaller.call(REVIEW_CHANGE_READ_TOOL_NAME, "over", before)).rejects.toThrow(
      new RegExp(
        `artifacts.maxObjectBytes: observed ${serialized} bytes.*configured ${serialized - 1} bytes`,
      ),
    );
    expect(smaller.set.getReviewChangeObservation()?.unavailable).toBe(true);
    const fullProposal = await fixture();
    await fullProposal.call(REVIEW_CHANGE_READ_TOOL_NAME, "proposal-read", before);
    await fullProposal.call(REVIEW_CHANGE_SELECT_TOOL_NAME, "proposal-select", proposed);
    const proposalBytes = Buffer.byteLength(
      JSON.stringify(fullProposal.set.getReviewChangeObservation()),
    );
    const proposalLimit = await fixture({ maxObjectBytes: proposalBytes - 1 });
    await proposalLimit.call(REVIEW_CHANGE_READ_TOOL_NAME, "limit-read", before);
    await expect(
      proposalLimit.call(REVIEW_CHANGE_SELECT_TOOL_NAME, "limit-select", proposed),
    ).rejects.toThrow(
      new RegExp(
        `artifacts.maxObjectBytes: observed ${proposalBytes} bytes.*configured ${proposalBytes - 1} bytes`,
      ),
    );
    expect(proposalLimit.set.getReviewChangeObservation()).toMatchObject({
      unavailable: true,
      delivered: [{ fileOrdinal: 0, side: "before" }],
      proposals: [],
    });
  });

  it("keeps attempt evidence isolated and screens configured credentials before capture", async () => {
    const first = await fixture();
    await first.call(REVIEW_CHANGE_READ_TOOL_NAME, "first-attempt-read", before);
    const second = await fixture();
    await expect(
      second.call(REVIEW_CHANGE_SELECT_TOOL_NAME, "reused-selection", proposed),
    ).rejects.toThrow("not fully delivered");
    expect(second.set.getReviewChangeObservation()?.proposals).toEqual([]);
    first.set.disposeReviewChangeObservation();
    expect(first.set.getReviewChangeObservation()?.delivered).toEqual([]);

    const secret = configureCredential("glpat-" + "b".repeat(24));
    const pinned = source();
    const unsafe: ReviewChangeSource = {
      ...pinned,
      readSide: (ordinal, side) => {
        const admitted = pinned.readSide(ordinal, side);
        return admitted
          ? { ...admitted, lines: [secret], lineBytes: [Buffer.from(`${secret}\n`)] }
          : undefined;
      },
    };
    const credential = await fixture({ sourceCapability: unsafe });
    await expect(
      credential.call(REVIEW_CHANGE_READ_TOOL_NAME, "screened", {
        ...before,
        endLine: 1,
      }),
    ).rejects.toThrow();
    expect(credential.set.getReviewChangeObservation()?.delivered).toEqual([]);
    await expect(
      credential.call(REVIEW_CHANGE_SELECT_TOOL_NAME, "screened-select", {
        ...proposed,
        endLine: 1,
      }),
    ).rejects.toThrow("not fully delivered");
  });

  it("refuses a configured multiline credential anywhere in the pinned side before slicing or labeling", async () => {
    for (const newline of ["\n", "\r\n"]) {
      const configured = configureCredential(
        ["fixture opening", "fixture middle 7Qz9", "fixture closing"].join(newline),
      );
      const raw = `ordinary prefix${newline}${configured}${newline}ordinary suffix${newline}`;
      const lineBytes = (raw.match(/[^\n]*\n|[^\n]+$/gu) ?? []).map((line) => Buffer.from(line));
      const pinned = source();
      const unsafe: ReviewChangeSource = {
        ...pinned,
        readSide: (ordinal, side) => {
          const admitted = pinned.readSide(ordinal, side);
          if (!admitted || ordinal !== 0 || side !== "before") return admitted;
          return {
            ...admitted,
            rawSha256: sha256(raw),
            lines: lineBytes.map((line) => line.toString("utf8").replace(/\n$/u, "")),
            lineBytes,
          };
        },
      };
      const { set, call } = await fixture({ sourceCapability: unsafe });
      for (const range of [
        { startLine: 2, endLine: 4 },
        { startLine: 2, endLine: 2 },
        { startLine: 1, endLine: 1 },
        { startLine: 5, endLine: 5 },
      ]) {
        let rejection: unknown;
        try {
          await call(
            REVIEW_CHANGE_READ_TOOL_NAME,
            `${newline.length}-${range.startLine}-${range.endLine}`,
            {
              fileOrdinal: 0,
              side: "before",
              ...range,
            },
          );
        } catch (caught) {
          rejection = caught;
        }
        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as Error).message).toContain("credential-isolation boundary");
        expect(String(rejection)).not.toContain(configured);
      }
      expect(set.getReviewChangeObservation()?.delivered).toEqual([]);
      await expect(
        call(REVIEW_CHANGE_SELECT_TOOL_NAME, `refused-select-${newline.length}`, {
          originalIssueId: "TECH-REFUSED",
          fileOrdinal: 0,
          side: "before",
          startLine: 2,
          endLine: 2,
        }),
      ).rejects.toThrow("not fully delivered");

      const safe = await call(REVIEW_CHANGE_READ_TOOL_NAME, `safe-${newline.length}`, {
        fileOrdinal: 1,
        side: "after",
        startLine: 1,
        endLine: 1,
      });
      expect(text(safe)).toContain("[source-line 1] same text");
      expect(set.getReviewChangeObservation()?.delivered).toMatchObject([
        { fileOrdinal: 1, side: "after", startLine: 1, endLine: 1 },
      ]);
    }
  });
});
