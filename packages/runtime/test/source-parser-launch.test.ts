// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOURCE_EXTRACTION_LIMITS,
  extractSourceRepresentation,
  htmlSourceExtractorAdapter,
  launchSourceParser,
  originalBudgetExceededError,
  probeSourceParserConfinement,
  SourceExtractionError,
  type SourceExtractionRequestV1,
  SourceParserLaunchError,
} from "../src/inputs/index.js";

const HTML = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/html/release-notes.html", import.meta.url)),
);

/**
 * Positive control for this file. Every refusal below is built from this exact
 * launch with one thing changed, so a green refusal cannot be an artifact of a
 * broken fixture.
 */
function cleanLaunch() {
  return {
    adapter: htmlSourceExtractorAdapter,
    bytes: HTML,
    mediaType: "text/html",
    executionMode: "in-process-inert" as const,
  };
}

describe("confined source parser launch", () => {
  it("runs the inert in-process adapter and returns real spans", async () => {
    const result = await launchSourceParser(cleanLaunch());
    expect(result.executionMode).toBe("in-process-inert");
    expect(result.representation.spans.length).toBeGreaterThan(3);
    expect(result.representation.sha256).not.toBe(result.originalSha256);
  });

  it("refuses a subprocess parser when no confinement was probed at all", async () => {
    await expect(
      launchSourceParser({ ...cleanLaunch(), executionMode: "confined-subprocess" }),
    ).rejects.toThrowError(new SourceParserLaunchError("confinement-unavailable"));
  });

  it("refuses a subprocess parser when the probe actually failed", async () => {
    const probe = probeSourceParserConfinement({
      platform: "linux",
      run: () => {
        throw new Error("bwrap is not installed");
      },
    });
    expect(probe.mechanism).toBe("bubblewrap");
    expect(probe.available).toBe(false);
    expect(probe.reasonCode).toBe("probe-failed");
    await expect(
      launchSourceParser({
        ...cleanLaunch(),
        executionMode: "confined-subprocess",
        confinement: probe,
      }),
    ).rejects.toThrowError(new SourceParserLaunchError("confinement-unavailable"));
  });

  it("still refuses a subprocess parser after a successful probe, because none exists", async () => {
    // A successful probe proves the host has the mechanism. It does not make
    // this module spawn or confine anything, so the mode must refuse rather
    // than quietly run the adapter in-process under a confinement claim.
    const probe = probeSourceParserConfinement({ platform: "linux", run: () => undefined });
    expect(probe.available).toBe(true);
    expect(probe.reasonCode).toBe("probe-succeeded");
    await expect(
      launchSourceParser({
        ...cleanLaunch(),
        executionMode: "confined-subprocess",
        confinement: probe,
      }),
    ).rejects.toThrowError(new SourceParserLaunchError("subprocess-unimplemented"));
  });

  it("never runs an adapter under a confined-subprocess request", async () => {
    let ran = false;
    const probe = probeSourceParserConfinement({ platform: "linux", run: () => undefined });
    const spy = {
      ...htmlSourceExtractorAdapter,
      extract: () => {
        ran = true;
        return {
          segments: [
            {
              text: "x",
              locator: {
                kind: "html-node" as const,
                nodeOrdinal: 0,
                textStartByte: 0,
                textEndByte: 1,
              },
            },
          ],
          limitations: [],
        };
      },
    };
    await expect(
      launchSourceParser({
        ...cleanLaunch(),
        adapter: spy,
        executionMode: "confined-subprocess",
        confinement: probe,
      }),
    ).rejects.toThrowError(new SourceParserLaunchError("subprocess-unimplemented"));
    expect(ran).toBe(false);
  });

  it("reports an unsupported platform as unconfined rather than assuming a sandbox", () => {
    const probe = probeSourceParserConfinement({ platform: "sunos" });
    expect(probe.mechanism).toBe("none");
    expect(probe.available).toBe(false);
    expect(probe.reasonCode).toBe("unsupported-platform");
  });

  it("probes the real mechanism of the running host", () => {
    // A real probe, not a description of one: on Linux this runs bwrap and on
    // macOS it runs sandbox-exec. The claim recorded is whatever happened.
    const probe = probeSourceParserConfinement();
    expect(probe.platform).toBe(process.platform);
    expect(["bubblewrap", "sandbox-exec", "none"]).toContain(probe.mechanism);
    expect(probe.reasonCode).toBe(
      probe.mechanism === "none"
        ? "unsupported-platform"
        : probe.available
          ? "probe-succeeded"
          : "probe-failed",
    );
  });

  it("rejects an unknown execution mode", async () => {
    await expect(
      launchSourceParser({ ...cleanLaunch(), executionMode: "raw-host" as never }),
    ).rejects.toThrowError(new SourceParserLaunchError("unsupported-execution-mode"));
  });

  it("rejects a non-positive deadline before running anything", async () => {
    await expect(launchSourceParser({ ...cleanLaunch(), deadlineMs: 0 })).rejects.toThrowError(
      new SourceParserLaunchError("deadline-exceeded"),
    );
  });

  it("rejects an extraction that overran its deadline", async () => {
    let clock = 0;
    await expect(
      launchSourceParser({
        ...cleanLaunch(),
        // Wide enough that the HTML adapter finishes inside the race, so the
        // refusal below comes from the clock-based post-check. That check is a
        // second guard, not a restatement of the race.
        deadlineMs: 5_000,
        now: () => {
          clock += 1_000_000;
          return clock;
        },
      }),
    ).rejects.toThrowError(new SourceParserLaunchError("deadline-exceeded"));
  });

  it("rejects an already cancelled launch", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      launchSourceParser({ ...cleanLaunch(), signal: controller.signal }),
    ).rejects.toThrowError(new SourceParserLaunchError("cancelled"));
  });

  it("reports an adapter that outran the wall-clock deadline as deadline-exceeded", async () => {
    // A real race, not a description of one: this adapter never resolves, so
    // only a host-side deadline can end the launch.
    const stuck = {
      ...htmlSourceExtractorAdapter,
      extract: () => new Promise<never>(() => undefined),
    };
    await expect(
      launchSourceParser({ ...cleanLaunch(), adapter: stuck, deadlineMs: 25 }),
    ).rejects.toThrowError(new SourceParserLaunchError("deadline-exceeded"));
  });

  it("awaits a promise-returning adapter inside the same launch wrapper", async () => {
    const asyncHtml = {
      ...htmlSourceExtractorAdapter,
      extract: async (request: SourceExtractionRequestV1) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return htmlSourceExtractorAdapter.extract(request);
      },
    };
    const asyncResult = await launchSourceParser({ ...cleanLaunch(), adapter: asyncHtml });
    const syncResult = await launchSourceParser(cleanLaunch());
    expect(asyncResult.executionMode).toBe("in-process-inert");
    expect(asyncResult.representation.sha256).toBe(syncResult.representation.sha256);
    expect(asyncResult.representation.representationId).toBe(
      syncResult.representation.representationId,
    );
  });

  it("never lets a launch deadline widen the seam's own extraction ceiling", async () => {
    const stuck = {
      ...htmlSourceExtractorAdapter,
      extract: () => new Promise<never>(() => undefined),
    };
    // deadlineMs is generous; limits.maxExtractionMs is tight. The tighter one
    // must win, or one argument could buy an unbounded parse.
    await expect(
      launchSourceParser({
        ...cleanLaunch(),
        adapter: stuck,
        deadlineMs: 60_000,
        limits: { maxExtractionMs: 25 },
      }),
    ).rejects.toThrowError(new SourceParserLaunchError("deadline-exceeded"));
  });
});

describe("finite extraction budgets", () => {
  it("keeps the shipped defaults finite", () => {
    expect(DEFAULT_SOURCE_EXTRACTION_LIMITS.maxOriginalBytes).toBeGreaterThan(0);
    expect(DEFAULT_SOURCE_EXTRACTION_LIMITS.maxDerivativeBytes).toBeLessThanOrEqual(
      DEFAULT_SOURCE_EXTRACTION_LIMITS.maxOriginalBytes,
    );
    expect(DEFAULT_SOURCE_EXTRACTION_LIMITS.maxSpans).toBeGreaterThan(0);
    expect(DEFAULT_SOURCE_EXTRACTION_LIMITS.maxExtractionMs).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_SOURCE_EXTRACTION_LIMITS.maxExtractionMs)).toBe(true);
  });

  it("fails closed on an oversized original instead of truncating it", async () => {
    await expect(
      launchSourceParser({ ...cleanLaunch(), limits: { maxOriginalBytes: 32 } }),
    ).rejects.toThrowError(originalBudgetExceededError(HTML.byteLength, 32));
  });

  it("truncates the derivative under a byte budget and names the limitation", async () => {
    const { representation } = await launchSourceParser({
      ...cleanLaunch(),
      limits: { maxDerivativeBytes: 150 },
    });
    expect(representation.byteLength).toBeLessThanOrEqual(150);
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("byte-budget-truncated");
  });

  it("truncates spans under a span budget and names the limitation", async () => {
    const { representation } = await launchSourceParser({
      ...cleanLaunch(),
      limits: { maxSpans: 3 },
    });
    expect(representation.spans).toHaveLength(3);
    expect(representation.limitations).toContain("span-budget-truncated");
  });

  it("refuses an adapter that does not claim the original media type", async () => {
    await expect(
      extractSourceRepresentation({
        adapter: htmlSourceExtractorAdapter,
        bytes: HTML,
        mediaType: "application/pdf",
      }),
    ).rejects.toThrowError(new SourceExtractionError("unsupported-media-type"));
  });

  it("refuses an adapter that emits a locator kind it did not declare", async () => {
    const wrongLocator = {
      ...htmlSourceExtractorAdapter,
      extract: () => ({
        segments: [
          {
            text: "forged",
            locator: { kind: "pdf-page" as const, pageNumber: 1, itemStart: 0, itemEnd: 1 },
          },
        ],
        limitations: [],
      }),
    };
    await expect(
      extractSourceRepresentation({
        adapter: wrongLocator,
        bytes: HTML,
        mediaType: "text/html",
      }),
    ).rejects.toThrowError(new SourceExtractionError("adapter-invalid"));
  });

  it("refuses an adapter that produced nothing readable", async () => {
    const empty = {
      ...htmlSourceExtractorAdapter,
      extract: () => ({ segments: [], limitations: [] }),
    };
    await expect(
      extractSourceRepresentation({ adapter: empty, bytes: HTML, mediaType: "text/html" }),
    ).rejects.toThrowError(new SourceExtractionError("empty-extraction"));
  });
});
