// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One run, three formats, one binding: a `docsfab run` selecting HTML, DOCX and
 * PDF originals seals one `SourceBindingV1` and discloses all three locator
 * kinds through one inventory call.
 *
 * The extension decides which adapter is offered the bytes, never what the
 * bytes are, so an allowlisted extension over another format's bytes fails
 * closed.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { DOCX_MEDIA_TYPE } from "../src/inputs/adapters/docx.js";
import { PDF_MEDIA_TYPE } from "../src/inputs/adapters/pdf.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  assertInventoryDisclosesNoSourceText,
  createSourceFixture,
  HTML_SOURCE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const DOCX_PATH = "docs/release-notes.docx";
const PDF_PATH = "docs/release-notes.pdf";
const DECOY_PDF_PATH = "docs/decoy.pdf";
const DECOY_DOCX_PATH = "docs/decoy.docx";
const ALL_THREE = [HTML_SOURCE_PATH, DOCX_PATH, PDF_PATH] as const;

const DOCX_BYTES = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/docx/basic-document.docx", import.meta.url)),
);
const PDF_BYTES = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/pdf/simple-two-page.pdf", import.meta.url)),
);

afterEach(async () => {
  process.exitCode = undefined;
});

describe("docsfab run --source across three formats in one run (#835)", () => {
  it("seals one binding covering an HTML, a DOCX, and a PDF original", async () => {
    const fixture = await createSourceFixture({
      [DOCX_PATH]: DOCX_BYTES,
      [PDF_PATH]: PDF_BYTES,
    });
    roots.track(fixture.root);
    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: ALL_THREE,
    });

    const record = await executeRunRequest(
      runRequest(fixture, ALL_THREE),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");

    // One inventory call disclosed all three originals.
    expect(model.sawListToolOn).toEqual(["plan-documentation"]);
    expect(model.listedPaths.toSorted()).toEqual([...ALL_THREE].toSorted());
    expect(model.locatorKinds.toSorted()).toEqual(["docx-block", "html-node", "pdf-page"]);
    expect(new Set(model.listed.map((entry) => entry.mediaType))).toEqual(
      new Set(["text/html", DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE]),
    );

    // Three distinct observations, and every span id is host-minted.
    const observationIds = new Set(model.listed.map((entry) => entry.observationId));
    expect(observationIds.size).toBe(3);
    expect(model.listed.every((entry) => /^span-[a-f0-9]{64}$/u.test(entry.spanId))).toBe(true);

    expect(model.toolReads).toHaveLength(3);
    expect(model.writerCalls).toBe(1);

    // One plan binding, sealed against one source binding digest.
    const planStep = record!.steps.find((step) => step.skill === "plan-documentation");
    expect(planStep?.planBinding?.schemaVersion).toBe(2);
    const digest = (planStep?.planBinding as { sourceBindingSha256?: string } | undefined)
      ?.sourceBindingSha256;
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    // Every step with a plan binding carries the same source digest.
    const digests = new Set(
      record!.steps
        .map((step) => step.planBinding as { sourceBindingSha256?: string } | undefined)
        .filter((binding): binding is { sourceBindingSha256: string } =>
          Boolean(binding?.sourceBindingSha256),
        )
        .map((binding) => binding.sourceBindingSha256),
    );
    expect([...digests]).toEqual([digest]);
  }, 90_000);

  it("discloses identity and position only, never a word of any of the three sources", async () => {
    // Three formats' derivatives pass through one inventory call.
    const fixture = await createSourceFixture({
      [DOCX_PATH]: DOCX_BYTES,
      [PDF_PATH]: PDF_BYTES,
    });
    roots.track(fixture.root);
    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      readAllSpans: true,
      planSourcePaths: ALL_THREE,
    });

    await executeRunRequest(runRequest(fixture, ALL_THREE), runtimeConfig(fixture.stateDirectory), {
      silent: true,
      executionHarness: model,
      skillResolver,
    });

    // Every span of all three documents, so the guard sees the whole corpus.
    expect(model.toolReads.length).toBe(model.listed.length);
    expect(model.toolReads.length).toBeGreaterThan(10);
    assertInventoryDisclosesNoSourceText(model, {
      repositoryPaths: [...ALL_THREE],
      mediaTypes: ["text/html", DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE],
    });
  }, 90_000);

  it("reads every selected source the planner only listed into the write step, whole", async () => {
    // Every selected source is required, so the write step reads all three.
    const fixture = await createSourceFixture({
      [DOCX_PATH]: DOCX_BYTES,
      [PDF_PATH]: PDF_BYTES,
    });
    roots.track(fixture.root);
    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      listOnly: true,
      planSourcePaths: ALL_THREE,
    });

    const record = await executeRunRequest(
      runRequest(fixture, ALL_THREE),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(model.listed.length).toBeGreaterThan(0);
    expect(model.toolReads).toEqual([]);
    expect(record?.status, record?.error).toBe("succeeded");
    expect(model.writerCalls).toBe(1);
    expect(new Set(model.hostReads.map((source) => source.stepId))).toEqual(
      new Set(["write-documentation"]),
    );
    expect(model.hostReads.map((source) => source.repositoryPath).toSorted()).toEqual(
      [...ALL_THREE].toSorted(),
    );
    // Each source whole: exactly the spans the planner's inventory listed for it.
    for (const source of model.hostReads) {
      expect(source.spans.map((span) => span.spanId)).toEqual(
        model.listed
          .filter((entry) => entry.observationId === source.observationId)
          .map((entry) => entry.spanId),
      );
    }
  }, 90_000);
});

describe("docsfab run --source refuses an extension that lied about its bytes (#835)", () => {
  it("refuses a tracked .pdf whose bytes are a DOCX package", async () => {
    const fixture = await createSourceFixture({ [DECOY_PDF_PATH]: DOCX_BYTES });
    roots.track(fixture.root);
    const model = new SourceToolHarness({
      readOnSkill: null,
      planSourcePaths: [DECOY_PDF_PATH],
    });

    // The PDF adapter refused these bytes and no other adapter was offered them.
    await expect(
      executeRunRequest(
        runRequest(fixture, [DECOY_PDF_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      ),
    ).rejects.toThrowError(/extractor-limitation/u);
    expect(model.sawReaderOn).toEqual([]);
    expect(model.sawReferenceOn).toEqual([]);
    expect(model.writerCalls).toBe(0);
  }, 90_000);

  it("refuses a tracked .docx whose bytes are a PDF document", async () => {
    const fixture = await createSourceFixture({ [DECOY_DOCX_PATH]: PDF_BYTES });
    roots.track(fixture.root);
    const model = new SourceToolHarness({
      readOnSkill: null,
      planSourcePaths: [DECOY_DOCX_PATH],
    });

    await expect(
      executeRunRequest(
        runRequest(fixture, [DECOY_DOCX_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      ),
    ).rejects.toThrowError(/extractor-limitation/u);
    expect(model.sawReaderOn).toEqual([]);
    expect(model.writerCalls).toBe(0);
  }, 90_000);

  it("keeps the same bytes acceptable under their honest extension", async () => {
    // Positive control: the refusals above are the format mismatch, not unreadable fixtures.
    const fixture = await createSourceFixture({
      [DOCX_PATH]: DOCX_BYTES,
      [PDF_PATH]: PDF_BYTES,
    });
    roots.track(fixture.root);
    const model = new SourceToolHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [DOCX_PATH, PDF_PATH],
    });

    const record = await executeRunRequest(
      runRequest(fixture, [DOCX_PATH, PDF_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status).toBe("succeeded");
    expect(model.locatorKinds.toSorted()).toEqual(["docx-block", "pdf-page"]);
    expect(model.toolReads).toHaveLength(2);
  }, 90_000);
});

/**
 * Guards the decoy cases above, which would also pass if these fixtures stopped
 * being the formats they claim.
 */
describe("mixed-format fixture sanity (#835)", () => {
  it("uses real originals of two different formats, not placeholders", () => {
    expect(Buffer.from(DOCX_BYTES.subarray(0, 2)).toString("latin1")).toBe("PK");
    expect(Buffer.from(PDF_BYTES.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });
});
