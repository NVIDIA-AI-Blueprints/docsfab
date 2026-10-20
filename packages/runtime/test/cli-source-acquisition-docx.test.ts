// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --source <docx>` through the real CLI composition root: the twin
 * of `cli-source-acquisition-pdf.test.ts` for the DOCX adapter and its
 * `docx-block` locators, proving a second registry entry is reachable from the
 * shipped CLI. Every identifier comes from `docsfab_list_sources` alone.
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { DOCX_MEDIA_TYPE } from "../src/inputs/adapters/docx.js";
import type { RunRecord } from "../src/records/contracts.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  assertInventoryDisclosesNoSourceText,
  createSourceFixture,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const SOURCE_PATH = "docs/release-notes.docx";

/** The DOCX branch's committed fixtures, used here as the tracked originals. */
const BASIC = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/docx/basic-document.docx", import.meta.url)),
);
const DIVERGENT = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/docx/divergent-document.docx", import.meta.url)),
);

const FIRST_BLOCK_TEXT = "Release Notes";
const DIVERGENT_FIRST_BLOCK_TEXT = "Divergent Notes";

function docxFixture() {
  return createSourceFixture({ [SOURCE_PATH]: BASIC });
}

function harness(readOnSkill: string | null, listOnly = false) {
  return new SourceToolHarness({ readOnSkill, listOnly, planSourcePaths: [SOURCE_PATH] });
}

afterEach(async () => {
  process.exitCode = undefined;
});

describe("docsfab run --source <docx> end to end (#835/#838)", () => {
  it("acquires the tracked DOCX and seals a V2 plan binding over its source digest", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    const model = harness("plan-documentation");

    const record = await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");
    expect(model.sawReaderOn).toContain("plan-documentation");
    expect(model.sawReferenceOn).toContain("write-documentation");
    expect(model.writerCalls).toBe(1);

    const planStep = record!.steps.find((step) => step.skill === "plan-documentation");
    expect(planStep?.planBinding?.schemaVersion).toBe(2);
    expect(
      (planStep?.planBinding as { sourceBindingSha256?: string } | undefined)?.sourceBindingSha256,
    ).toMatch(/^[a-f0-9]{64}$/u);

    const saved = JSON.parse(
      await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
    ) as RunRecord;
    expect(saved).toStrictEqual(record);
  }, 60_000);

  it("discloses docx-block locators the step learned only from docsfab_list_sources", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    const model = harness("plan-documentation");

    await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(model.sawListToolOn).toEqual(["plan-documentation"]);
    expect(model.locatorKinds).toEqual(["docx-block"]);
    expect(model.listedPaths).toEqual([SOURCE_PATH]);
    expect(model.listed.every((entry) => entry.mediaType === DOCX_MEDIA_TYPE)).toBe(true);
    expect(model.listed.every((entry) => /^span-[a-f0-9]{64}$/u.test(entry.spanId))).toBe(true);
    // Body paragraphs and table cells, each citing the real main document part.
    expect(new Set(model.listed.map((entry) => (entry.locator as { part: string }).part))).toEqual(
      new Set(["word/document.xml"]),
    );
    expect(model.listed.some((entry) => (entry.locator as { tableCell: unknown }).tableCell)).toBe(
      true,
    );
    expect(
      model.listed.some((entry) => (entry.locator as { tableCell: unknown }).tableCell === null),
    ).toBe(true);
    // The no-source-text property is asserted structurally in the next case.
  }, 60_000);

  it("discloses identity and position only, never a word of the block text", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    // Read every block, so the guard looks for every word the document has.
    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      readAllSpans: true,
      planSourcePaths: [SOURCE_PATH],
    });

    await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    assertInventoryDisclosesNoSourceText(model, {
      repositoryPaths: [SOURCE_PATH],
      mediaTypes: [DOCX_MEDIA_TYPE],
    });
  }, 60_000);

  it("returns real block text through docsfab_read_source", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    const model = harness("plan-documentation");

    await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(model.toolReads).toHaveLength(1);
    expect(model.toolReads[0]).toBe(FIRST_BLOCK_TEXT);
  }, 60_000);

  it("recomputes the spans from the committed revision, not the working tree", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    await writeFile(join(fixture.repository, SOURCE_PATH), DIVERGENT);
    const model = harness("plan-documentation");

    const record = await executeRunRequest(
      { ...runRequest(fixture, [SOURCE_PATH]), revision: fixture.revision },
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");
    expect(model.locatorKinds).toEqual(["docx-block"]);
    expect(new Set(model.listed.map((entry) => (entry.locator as { part: string }).part))).toEqual(
      new Set(["word/document.xml"]),
    );
    expect(model.toolReads).toHaveLength(1);
    expect(model.toolReads[0]).toBe(FIRST_BLOCK_TEXT);
    expect(model.toolReads[0]).not.toContain(DIVERGENT_FIRST_BLOCK_TEXT);
  }, 60_000);

  it("reads the required DOCX source into the write step when no earlier step read it", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    const model = harness(null);

    const record = await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status, record?.error).toBe("succeeded");
    expect(model.toolReads).toEqual([]);
    expect(model.writerCalls).toBe(1);
    expect(model.hostReads.map((source) => [source.stepId, source.repositoryPath])).toEqual([
      ["write-documentation", SOURCE_PATH],
    ]);
    expect(model.hostReads[0]!.spans[0]!.text).toBe(FIRST_BLOCK_TEXT);
  }, 60_000);

  it("refuses an untracked DOCX path before any workflow model call", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    const model = harness(null);

    // The refusal runs ahead of the knowledge evidence gate, so the operator
    // reads the actionable "no such source" sentence; the structured code stays.
    const error = (await executeRunRequest(
      runRequest(fixture, ["docs/not-committed.docx"]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    ).catch((caught: unknown) => caught)) as { code?: string; message: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("path-not-tracked");
    expect(error.message).toBe(
      "No such source: docs/not-committed.docx is not a tracked regular file at the selected revision. " +
        "Nothing was read and no model call was made. Check the path, or commit the file, then run again.",
    );
    expect(model.sawReaderOn).toEqual([]);
    expect(model.sawReferenceOn).toEqual([]);
  }, 60_000);

  it("leaves a run without --source on the V1 plan binding and no reader anywhere", async () => {
    const fixture = await docxFixture();
    roots.track(fixture.root);
    const model = harness(null);

    const record = await executeRunRequest(
      runRequest(fixture),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");
    expect(model.sawReaderOn).toEqual([]);
    expect(model.sawReferenceOn).toEqual([]);
    expect(
      record!.steps.find((step) => step.skill === "plan-documentation")?.planBinding?.schemaVersion,
    ).toBe(1);
    expect(model.writerCalls).toBe(1);
  }, 60_000);
});
