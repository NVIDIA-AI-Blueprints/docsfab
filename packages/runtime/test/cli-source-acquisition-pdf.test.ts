// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --source <pdf>` through the real CLI composition root. The
 * adapter is tested alone in `source-evidence-pdf.test.ts`; this suite proves
 * it is wired: registered, reachable through the extension allowlist, fed bytes
 * from a real Git revision, and disclosed as `pdf-page` spans.
 *
 * Every identifier comes from `docsfab_list_sources` alone, so a registration or
 * disclosure mistake fails here.
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { PDF_MEDIA_TYPE } from "../src/inputs/adapters/pdf.js";
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
const SOURCE_PATH = "docs/release-notes.pdf";

/** The PDF branch's committed fixtures, used here as the tracked originals. */
const SIMPLE = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/pdf/simple-two-page.pdf", import.meta.url)),
);
const DIVERGENT = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/pdf/divergent-two-page.pdf", import.meta.url)),
);
const HEURISTIC = new Uint8Array(
  readFileSync(
    new URL("./fixtures/source-evidence/pdf/type0-heuristic-encoding.pdf", import.meta.url),
  ),
);
const TOUNICODE = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/pdf/type0-tounicode.pdf", import.meta.url)),
);

const PAGE_ONE_TEXT =
  "The quick brown fox jumps over the lazy dog.\nAccents: café, señor, über, façade.";
const DIVERGENT_PAGE_ONE_TEXT =
  "The five boxing wizards jump quickly.\nAccents: garçon, mañana, naïve, crema catalana.";

function pdfFixture() {
  return createSourceFixture({ [SOURCE_PATH]: SIMPLE });
}

function harness(readOnSkill: string | null, listOnly = false) {
  return new SourceToolHarness({ readOnSkill, listOnly, planSourcePaths: [SOURCE_PATH] });
}

afterEach(async () => {
  process.exitCode = undefined;
});

describe("docsfab run --source <pdf> end to end (#835/#837)", () => {
  it("acquires the tracked PDF and seals a V2 plan binding over its source digest", async () => {
    const fixture = await pdfFixture();
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

  it("discloses pdf-page locators the step learned only from docsfab_list_sources", async () => {
    const fixture = await pdfFixture();
    roots.track(fixture.root);
    const model = harness("plan-documentation");

    await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(model.sawListToolOn).toEqual(["plan-documentation"]);
    expect(model.locatorKinds).toEqual(["pdf-page"]);
    expect(model.listedPaths).toEqual([SOURCE_PATH]);
    expect(model.listed.every((entry) => entry.mediaType === PDF_MEDIA_TYPE)).toBe(true);
    expect(model.listed.every((entry) => /^span-[a-f0-9]{64}$/u.test(entry.spanId))).toBe(true);
    expect(
      model.listed.map((entry) => (entry.locator as { pageNumber: number }).pageNumber),
    ).toEqual([1, 2]);
    // The no-source-text property is asserted structurally in the next case.
  }, 60_000);

  it("discloses identity and position only, never a word of the page text", async () => {
    const fixture = await pdfFixture();
    roots.track(fixture.root);
    // Read every page, so the guard looks for every word the document has.
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
      mediaTypes: [PDF_MEDIA_TYPE],
    });
  }, 60_000);

  it("returns real page text through docsfab_read_source", async () => {
    const fixture = await pdfFixture();
    roots.track(fixture.root);
    const model = harness("plan-documentation");

    await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(model.toolReads).toHaveLength(1);
    expect(model.toolReads[0]).toBe(PAGE_ONE_TEXT);
  }, 60_000);

  it("recomputes the spans from the committed revision, not the working tree", async () => {
    const fixture = await pdfFixture();
    roots.track(fixture.root);
    // Replace the tracked PDF after the selected commit; only the bytes the host
    // read can distinguish the two.
    await writeFile(join(fixture.repository, SOURCE_PATH), DIVERGENT);
    const model = harness("plan-documentation");

    const record = await executeRunRequest(
      { ...runRequest(fixture, [SOURCE_PATH]), revision: fixture.revision },
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");
    expect(model.locatorKinds).toEqual(["pdf-page"]);
    expect(
      model.listed.map((entry) => (entry.locator as { pageNumber: number }).pageNumber),
    ).toEqual([1, 2]);
    expect(model.toolReads).toHaveLength(1);
    expect(model.toolReads[0]).toBe(PAGE_ONE_TEXT);
    expect(model.toolReads[0]).not.toContain(DIVERGENT_PAGE_ONE_TEXT);
  }, 60_000);

  it("reads the required PDF source into the write step when no earlier step read it", async () => {
    const fixture = await pdfFixture();
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
    // Both pages: the whole source, not the first span.
    expect(model.hostReads[0]!.spans).toHaveLength(2);
    expect(model.hostReads[0]!.spans[0]!.text).toBe(PAGE_ONE_TEXT);
  }, 60_000);

  it("refuses an untracked PDF path before any workflow model call", async () => {
    const fixture = await pdfFixture();
    roots.track(fixture.root);
    const model = harness(null);

    // The refusal runs ahead of the knowledge evidence gate, so the operator
    // reads the actionable "no such source" sentence; the structured code stays.
    const error = (await executeRunRequest(
      runRequest(fixture, ["docs/not-committed.pdf"]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    ).catch((caught: unknown) => caught)) as { code?: string; message: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("path-not-tracked");
    expect(error.message).toBe(
      "No such source: docs/not-committed.pdf is not a tracked regular file at the selected revision. " +
        "Nothing was read and no model call was made. Check the path, or commit the file, then run again.",
    );
    expect(model.sawReaderOn).toEqual([]);
    expect(model.sawReferenceOn).toEqual([]);
  }, 60_000);

  it("leaves a run without --source on the V1 plan binding and no reader anywhere", async () => {
    const fixture = await pdfFixture();
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

  it("currently quotes heuristic Type0 CID text as complete because pdfjs-dist@6.3.289 exposes no text-API ToUnicode indicator", async () => {
    const fixture = await createSourceFixture({ [SOURCE_PATH]: HEURISTIC });
    roots.track(fixture.root);
    const model = harness("plan-documentation");

    const record = await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");
    expect(model.toolReads).toEqual(["012"]);
    expect(model.locatorKinds).toEqual(["pdf-page"]);
    expect(model.listedPayloads.length).toBeGreaterThan(0);
    for (const payload of model.listedPayloads) {
      const envelope = JSON.parse(payload) as { spans: Array<Record<string, unknown>> };
      for (const entry of envelope.spans) {
        expect(Object.hasOwn(entry, "text")).toBe(false);
        expect(Object.hasOwn(entry, "limitations")).toBe(false);
      }
      expect(payload).not.toContain("heuristic-encoding");
    }
    expect(model.writerCalls).toBe(1);
  }, 60_000);

  it("quotes a Type0 control with a real ToUnicode CMap as ABC rather than heuristic 012", async () => {
    const fixture = await createSourceFixture({ [SOURCE_PATH]: TOUNICODE });
    roots.track(fixture.root);
    const model = harness("plan-documentation");

    const record = await executeRunRequest(
      runRequest(fixture, [SOURCE_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");
    expect(model.toolReads).toEqual(["ABC"]);
    expect(model.toolReads[0]).not.toBe("012");
    expect(model.locatorKinds).toEqual(["pdf-page"]);
    expect(model.writerCalls).toBe(1);
  }, 60_000);
});
