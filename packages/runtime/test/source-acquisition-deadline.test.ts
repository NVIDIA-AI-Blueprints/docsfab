// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The producer's budget refusals are their own refusals.
 *
 * A fired wall-clock deadline says nothing about the file: the same bytes
 * under a larger budget may bind. So it must not collapse into
 * `extractor-limitation`, which tells an operator DocsFab cannot decode their
 * file. These cases pin the distinction end to end (the producer code, the
 * seam code it was translated from, and the CLI message) and pin that the
 * refusal is still fail-closed.
 *
 * Every timeout here is produced by the real deadline in
 * `extractSourceRepresentation`, not a thrown stand-in, so removing the race
 * fails these tests.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  cliSourceExtractionLimits,
  CliSourceAcquisitionError,
  describeCliSourceRefusal,
  resolveCliSourceEvidence,
} from "../src/cli/run/source-acquisition.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import {
  SourceAcquisitionError,
  acquireTrackedSourceBinding,
} from "../src/inputs/source-acquisition.js";
import {
  createSourceExtractorRegistry,
  type SourceExtractionRequestV1,
  type SourceExtractionResultV1,
  type SourceExtractorAdapterV1,
} from "../src/inputs/source-extraction.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { removeFixture } from "./support/execution-convergence.js";
import { createSourceFixture } from "./support/source-acquisition-cli.js";

const REPOSITORY_PATH = "/tmp/deadline-fixture";
const REPOSITORY = {
  identitySha256: createHash("sha256").update(REPOSITORY_PATH).digest("hex"),
  revision: "c".repeat(40),
};
const RUN_ID_SHA = createHash("sha256").update("deadline-run", "utf8").digest("hex");
const REQUEST_SHA = createHash("sha256").update("deadline-request", "utf8").digest("hex");
const POLICY_SHA = createHash("sha256").update("deadline-policy", "utf8").digest("hex");
const OBSERVED_AT = "2026-09-15T09:00:00.000Z";

const PAGE = "<html><body><p>Ordinary release prose for the deadline fixture.</p></body></html>";

/** One adapter's completed extractions, so a test can prove a file really bound. */
interface AdapterCalls {
  readonly completed: string[];
}

/**
 * An adapter that yields for `stallMs` before answering.
 *
 * It awaits, so the host's timer can fire: the deadline can stop only an
 * adapter that yields. A stall of `0` is the same adapter answering at once,
 * which makes the positive control a control over this exact code.
 *
 * `mediaTypes` lets one acquisition mix a fast adapter and a slow one, so the
 * mixed-run case can put the slow file last and still refuse everything.
 */
function stallingAdapter(
  id: string,
  mediaTypes: readonly string[],
  stallMs: number,
  calls: AdapterCalls,
): SourceExtractorAdapterV1 {
  return Object.freeze({
    id,
    version: "1",
    locatorKind: "text" as const,
    mediaTypes: Object.freeze([...mediaTypes]),
    defaultOptions: Object.freeze({}),
    async extract(request: SourceExtractionRequestV1): Promise<SourceExtractionResultV1> {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, stallMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      // Recorded only after the stall, so a call the host abandoned mid-flight
      // is not counted as a finished extraction.
      calls.completed.push(id);
      return {
        segments: [
          {
            text: Buffer.from(request.bytes).toString("utf8").slice(0, 32),
            locator: { kind: "text", startByte: 0, endByte: 32 },
          },
        ],
        limitations: [],
      };
    },
  });
}

function acquire(options: {
  files: Record<string, string>;
  selection: readonly string[];
  stallMs: number;
  maxExtractionMs: number;
  signal?: AbortSignal;
  /** Extra adapters, claiming media types the stalling HTML adapter does not. */
  extraAdapters?: readonly SourceExtractorAdapterV1[];
  calls?: AdapterCalls;
}) {
  const calls = options.calls ?? { completed: [] };
  return acquireTrackedSourceBinding({
    reader: {
      async isTrackedRegularFile(path) {
        return Object.hasOwn(options.files, path);
      },
      async readTrackedBytes(path) {
        return new TextEncoder().encode(options.files[path]!);
      },
    },
    externalInputs: openExternalInputAccessCapture({
      runIdSha256: RUN_ID_SHA,
      repository: REPOSITORY,
    }),
    registry: createSourceExtractorRegistry([
      stallingAdapter("test-html", ["text/html"], options.stallMs, calls),
      ...(options.extraAdapters ?? []),
    ]),
    selection: options.selection,
    readScope: ["."],
    runIdSha256: RUN_ID_SHA,
    repository: REPOSITORY,
    requestSha256: REQUEST_SHA,
    hostPolicySha256: POLICY_SHA,
    observedAt: OBSERVED_AT,
    limits: { maxExtractionMs: options.maxExtractionMs },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** The producer refusal the call actually threw, or a failure if it did not throw. */
async function refusalOf(promise: Promise<unknown>): Promise<SourceAcquisitionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceAcquisitionError);
    return error as SourceAcquisitionError;
  }
  throw new Error("acquisition resolved where a refusal was expected");
}

describe("tracked source acquisition reports a fired deadline as its own refusal (#835)", () => {
  it("refuses a timed-out extraction with extraction-timed-out, not extractor-limitation", async () => {
    const refusal = await refusalOf(
      acquire({
        files: { "docs/slow.html": PAGE },
        selection: ["docs/slow.html"],
        stallMs: 5_000,
        maxExtractionMs: 20,
      }),
    );

    expect(refusal.code).toBe("extraction-timed-out");
    expect(refusal.code).not.toBe("extractor-limitation");
    // The seam's own reason survives the translation, so a reviewer can tell a
    // fired deadline from a cancelled run without re-deriving it.
    expect(refusal.extractionCode).toBe("extraction-deadline-exceeded");
    expect(refusal.repositoryPath).toBe("docs/slow.html");
  });

  it("binds the same file and the same adapter when the budget is not exceeded", async () => {
    // Positive control: without it the case above would pass just as well if
    // this adapter had become unreadable or every acquisition refused.
    const acquired = await acquire({
      files: { "docs/slow.html": PAGE },
      selection: ["docs/slow.html"],
      stallMs: 0,
      maxExtractionMs: 5_000,
    });

    expect(acquired.acquired).toHaveLength(1);
    expect(acquired.acquired[0]!.repositoryPath).toBe("docs/slow.html");
    expect(acquired.binding.bindingSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("refuses the whole binding with the new code when the LAST of three files times out", async () => {
    // No partial binding. Selection is sorted, so `docs/a.html` and
    // `docs/b.html` extract first and only `docs/z-slow.xhtml` runs long. An
    // implementation that sealed what it had bound would return a
    // two-observation binding; it must refuse everything and name the slow file.
    // A single stalling adapter for every file would refuse on the first path
    // and pass even if partial bindings were sealed.
    const calls: AdapterCalls = { completed: [] };
    const refusal = await refusalOf(
      acquire({
        files: {
          "docs/a.html": PAGE,
          "docs/b.html": PAGE,
          "docs/z-slow.xhtml": PAGE,
        },
        selection: ["docs/z-slow.xhtml", "docs/a.html", "docs/b.html"],
        // The HTML adapter, which serves the first two files, never stalls.
        stallMs: 0,
        maxExtractionMs: 50,
        extraAdapters: [
          stallingAdapter("test-slow-xhtml", ["application/xhtml+xml"], 5_000, calls),
        ],
        calls,
      }),
    );

    expect(refusal.code).toBe("extraction-timed-out");
    expect(refusal.extractionCode).toBe("extraction-deadline-exceeded");
    expect(refusal.repositoryPath).toBe("docs/z-slow.xhtml");
    // Two files extracted before the third ran long, so the refusal discarded
    // work that had already succeeded.
    expect(calls.completed).toEqual(["test-html", "test-html"]);
  });

  it("keeps a cancelled extraction distinct from a timed-out one", async () => {
    const controller = new AbortController();
    const promise = acquire({
      files: { "docs/slow.html": PAGE },
      selection: ["docs/slow.html"],
      stallMs: 5_000,
      maxExtractionMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const refusal = await refusalOf(promise);

    expect(refusal.code).toBe("extraction-cancelled");
    expect(refusal.extractionCode).toBe("extraction-cancelled");
    expect(refusal.code).not.toBe("extraction-timed-out");
    expect(refusal.code).not.toBe("extractor-limitation");
  });

  it("still reports a genuine extractor limitation as extractor-limitation", async () => {
    // Not every seam refusal becomes a budget refusal: a `.pdf` holding HTML
    // reaches the real PDF adapter, which refuses it on the bytes.
    const refusal = await refusalOf(
      acquireTrackedSourceBinding({
        reader: {
          async isTrackedRegularFile() {
            return true;
          },
          async readTrackedBytes() {
            return new TextEncoder().encode(PAGE);
          },
        },
        externalInputs: openExternalInputAccessCapture({
          runIdSha256: RUN_ID_SHA,
          repository: REPOSITORY,
        }),
        selection: ["docs/not-really.pdf"],
        readScope: ["."],
        runIdSha256: RUN_ID_SHA,
        repository: REPOSITORY,
        requestSha256: REQUEST_SHA,
        hostPolicySha256: POLICY_SHA,
        observedAt: OBSERVED_AT,
      }),
    );

    expect(refusal.code).toBe("extractor-limitation");
    expect(refusal.repositoryPath).toBe("docs/not-really.pdf");
  });
});

describe("the CLI names the extraction budget it enforced (#835)", () => {
  const roots: string[] = [];
  const workspaces: RepositoryWorkspace[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
    await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
  });

  it("passes the shipped 30s default, which is the number an operator sees", () => {
    expect(cliSourceExtractionLimits().maxExtractionMs).toBe(30_000);
  });

  it("surfaces a timed-out acquisition as its own message naming the budget", async () => {
    // The whole shipped CLI host path: a real tracked export, the real producer,
    // the real seam deadline, and the real PDF adapter. Only the budget is
    // tightened, through the documented host seam, so the deadline fires in
    // milliseconds.
    const bomb = new Uint8Array(
      readFileSync(
        new URL("./fixtures/source-evidence/pdf/chained-filter-bomb.pdf", import.meta.url),
      ),
    );
    const fixture = await createSourceFixture({ "docs/bomb.pdf": bomb });
    roots.push(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    let thrown: unknown;
    try {
      await resolveCliSourceEvidence({
        workspace,
        sourcePaths: ["docs/bomb.pdf"],
        admittedRequest: {
          workflow: "create-documentation",
          instruction: "Create the page from the bound source.",
          allowWrite: true,
        },
        runId: "deadline-run",
        limits: { maxExtractionMs: 25 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CliSourceAcquisitionError);
    const cliError = thrown as CliSourceAcquisitionError;
    expect(cliError.message).toContain("25 ms extraction budget");
    expect(cliError.message).toContain("docs/bomb.pdf");
    expect(cliError.message).toContain("Nothing was bound");
    // The structured refusal is preserved, seam code included.
    expect(cliError.code).toBe("extraction-timed-out");
    expect(cliError.refusal).toBeInstanceOf(SourceAcquisitionError);
    expect(cliError.refusal.extractionCode).toBe("extraction-deadline-exceeded");
    expect(cliError.cause).toBe(cliError.refusal);
  }, 60_000);

  it("leaves every other refusal with the producer's own message", async () => {
    // Re-describing one refusal must not rewrite the vocabulary: an untracked
    // path is still reported as the producer reported it.
    const fixture = await createSourceFixture();
    roots.push(fixture.root);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
    workspaces.push(workspace);

    await expect(
      resolveCliSourceEvidence({
        workspace,
        sourcePaths: ["docs/absent.html"],
        admittedRequest: {
          workflow: "create-documentation",
          instruction: "Create the page from the bound source.",
          allowWrite: true,
        },
        runId: "deadline-run",
      }),
    ).rejects.toThrowError(new SourceAcquisitionError("path-not-tracked", "docs/absent.html"));
  }, 60_000);

  it("re-describes only the two budget refusals", () => {
    const passthrough = new SourceAcquisitionError("extractor-limitation", "docs/a.pdf");
    expect(describeCliSourceRefusal(passthrough, 30_000)).toBe(passthrough);
    // Identity, not `toBeInstanceOf(Error)`, which any returned wrapper would
    // satisfy.
    const unrelated = new Error("unrelated");
    expect(describeCliSourceRefusal(unrelated, 30_000)).toBe(unrelated);

    const cancelled = describeCliSourceRefusal(
      new SourceAcquisitionError("extraction-cancelled", "docs/a.pdf", "extraction-cancelled"),
      30_000,
    );
    expect(cancelled).toBeInstanceOf(CliSourceAcquisitionError);
    expect((cancelled as CliSourceAcquisitionError).message).toContain("cancelled");
  });
});

/**
 * The remediation contract for the CLI's own re-descriptions.
 *
 * `test/cli-source-compatibility.test.ts` asserts the producer-level contract
 * over the shipped enumeration. For `extraction-timed-out` and
 * `extraction-cancelled` the CLI replaces the producer message with its own,
 * so those strings live outside that enumeration and are asserted here.
 * Shape, not length: a long message can still tell an operator nothing.
 */
describe("CLI source refusal re-description remediation contract (#798)", () => {
  /** Exactly the codes `describeCliSourceRefusal` re-describes. */
  const CLI_SOURCE_REDESCRIBED_CODES = ["extraction-timed-out", "extraction-cancelled"] as const;

  it.each([...CLI_SOURCE_REDESCRIBED_CODES])(
    "names a condition and the change that clears it on the %s re-description",
    (code) => {
      const described = describeCliSourceRefusal(
        new SourceAcquisitionError(code, "docs/release-notes.pdf"),
        cliSourceExtractionLimits().maxExtractionMs,
      );
      expect(described).toBeInstanceOf(CliSourceAcquisitionError);
      const message = (described as CliSourceAcquisitionError).message;

      // The condition half names the operator's own file, not the code.
      expect(message).toContain("docs/release-notes.pdf");
      expect(message).not.toContain(code);
      // Stating that nothing was bound tells the operator the run is clean.
      expect(message).toContain("Nothing was bound");

      const sentences = message.split(". ").filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      const remediation = sentences.at(-1) ?? "";
      expect(remediation).toMatch(
        /^(?:Name|Use|Remove|Check|Supply|Run|Correct|Replace|Select)\b/u,
      );
      expect(remediation).toMatch(/\brun\b[^.]*\bagain\b|\braise\b|\bsmaller\b/iu);
      expect(message.endsWith(".")).toBe(true);
      // The structured code survives the re-description, so a caller can still
      // branch on it without parsing the sentence.
      expect((described as CliSourceAcquisitionError).code).toBe(code);
    },
  );

  it("passes every other acquisition refusal through with the producer's own remediation", () => {
    // Control: the CLI re-describes exactly two codes. A third would silently
    // lose the producer's remediation, so the pass-through is asserted too.
    const untouched = new SourceAcquisitionError("path-not-tracked", "docs/missing.html");
    expect(describeCliSourceRefusal(untouched, cliSourceExtractionLimits().maxExtractionMs)).toBe(
      untouched,
    );
    expect(untouched.message).toMatch(/\brun\b[^.]*\bagain\b|\brun without\b/iu);
  });
});
