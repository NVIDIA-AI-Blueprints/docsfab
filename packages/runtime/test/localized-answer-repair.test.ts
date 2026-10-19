// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import { createSourceObligationAnswerRecordSession } from "../src/harness/source-obligation-answer-records.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/review-response.js";

const IDENTITY = "same-source-and-draft-digest";

function dimensionRecord() {
  return {
    status: "unverified",
    reason: "The available source does not settle this dimension.",
    sourceLocators: [],
    obligations: [],
  };
}

function call(type: string, record: unknown, key?: string): string {
  return JSON.stringify({ type, ...(key === undefined ? {} : { key }), record });
}

async function submit(
  session: ReturnType<typeof createSourceObligationAnswerRecordSession>,
  batchId: string,
  rows: readonly { readonly id: string; readonly raw: string }[],
) {
  const ids = rows.map(({ id }) => id);
  await session.capability.prepareBatch({
    batchId,
    toolCalls: rows.map(({ id, raw }) => ({ toolCallId: id, rawArguments: raw })),
    authorizedToolCallIds: ids,
  });
  const receipts = new Map(ids.map((id) => [id, session.capability.receipt(id)]));
  await session.capability.settle({
    batchId,
    toolCallIds: ids,
    authorizedToolCallIds: ids,
    successfulToolCallIds: ids.filter((id) => receipts.get(id)?.status !== "refused"),
    failedToolCallIds: ids.filter((id) => receipts.get(id)?.status === "refused"),
  });
  return receipts;
}

describe("localized answer repair over a source-obligation retry", () => {
  it("keeps admitted evidence and refusal accounting across a same-identity retry", async () => {
    const dimensions = TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      id: `dimension-${dimension}`,
      raw: call(
        "dimension",
        {
          ...dimensionRecord(),
          status: dimension === TECHNICAL_FACT_DIMENSIONS[0] ? "applicable" : "unverified",
        },
        dimension,
      ),
    }));
    const first = createSourceObligationAnswerRecordSession({
      continuationIdentitySha256: IDENTITY,
      validateRecord(type, value) {
        if (
          type === "obligation" &&
          (value as { statement?: string }).statement === "unsupported"
        ) {
          throw new InferenceStepError(
            "The source-obligation statement was refused.",
            "malformed-response",
            true,
            undefined,
            { code: "invalid-value", location: "$.dimensions[].obligations[].statement" },
          );
        }
      },
    });
    expect(
      [...(await submit(first, "valid-evidence", dimensions)).values()].every(
        (receipt) => receipt.status === "admitted",
      ),
    ).toBe(true);
    const rejected = await submit(first, "bad-obligation", [
      {
        id: "bad-obligation",
        raw: call("obligation", {
          sourceLocators: ["src/manual.md:1-2"],
          statement: "unsupported",
          evidenceClass: "source-observation",
          uncertainty: "The source may be incomplete.",
          dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
        }),
      },
    ]);
    expect(rejected.get("bad-obligation")).toMatchObject({
      status: "refused",
      code: "invalid-value",
      retry: "model-correctable",
    });
    const continuation = first.continuation();

    // This is the pre-fix retry behavior: a newly-created session starts empty.
    const restarted = createSourceObligationAnswerRecordSession({
      continuationIdentitySha256: IDENTITY,
      validateRecord: () => {},
    });
    expect(restarted.snapshot().rows.size).toBe(0);

    const resumed = createSourceObligationAnswerRecordSession({
      continuationIdentitySha256: IDENTITY,
      continuation,
      validateRecord: () => {},
    });
    expect(resumed.snapshot().rows.size).toBe(TECHNICAL_FACT_DIMENSIONS.length);
    expect(resumed.snapshot().refusals).toEqual(first.snapshot().refusals);
    expect(resumed.promptGuidance).toContain("Already admitted and retained: dimension:");
    const corrected = await submit(resumed, "corrected-obligation", [
      {
        id: "corrected-obligation",
        raw: call("obligation", {
          sourceLocators: ["src/manual.md:1-2"],
          statement: "The source declares a deterministic default.",
          evidenceClass: "source-observation",
          uncertainty: "The source may be incomplete.",
          dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
        }),
      },
    ]);
    expect(corrected.get("corrected-obligation")?.status).toBe("admitted");
    await submit(resumed, "close", [
      {
        id: "close",
        raw: call("proposal-note", { limitations: [], closed: true }),
      },
    ]);
    expect(await resumed.finish()).toMatchObject({ completeness: "bounded-not-proven" });
  });

  it("refuses continuation under a changed source or draft identity", async () => {
    const session = createSourceObligationAnswerRecordSession({
      continuationIdentitySha256: IDENTITY,
      validateRecord: () => {},
    });
    expect(() =>
      createSourceObligationAnswerRecordSession({
        continuationIdentitySha256: "changed-source-or-draft-digest",
        continuation: session.continuation(),
        validateRecord: () => {},
      }),
    ).toThrow(/does not match its step evidence identity/u);
  });

  it("rejects a copied or modified continuation token", async () => {
    const session = createSourceObligationAnswerRecordSession({
      continuationIdentitySha256: IDENTITY,
      validateRecord: () => {},
    });
    const continuation = session.continuation();
    const forged = Object.freeze({ ...continuation });
    expect(() =>
      createSourceObligationAnswerRecordSession({
        continuationIdentitySha256: IDENTITY,
        continuation: forged,
        validateRecord: () => {},
      }),
    ).toThrow(/does not match its step evidence identity/u);
  });

  it("reopens only a rejected proposal closure before a correctable retry", async () => {
    const session = createSourceObligationAnswerRecordSession({
      continuationIdentitySha256: IDENTITY,
      validateRecord: () => {},
    });
    const dimensions = TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      id: `dimension-${dimension}`,
      raw: call("dimension", dimensionRecord(), dimension),
    }));
    await submit(session, "dimensions", dimensions);
    await submit(session, "close", [
      { id: "close", raw: call("proposal-note", { limitations: [], closed: true }) },
    ]);
    const before = session.snapshot();
    session.reopenProposalAfterCorrectableRejection();
    const after = session.snapshot();

    expect(after.rows.size).toBe(before.rows.size - 1);
    expect(after.rows.has("proposal-note\u0000singleton")).toBe(false);
    expect(after.refusals).toEqual(before.refusals);
    const resumed = createSourceObligationAnswerRecordSession({
      continuationIdentitySha256: IDENTITY,
      continuation: session.continuation(),
      validateRecord: () => {},
    });
    expect(resumed.promptGuidance).toContain("Already admitted and retained: dimension:");
    expect(resumed.snapshot().rows.size).toBe(TECHNICAL_FACT_DIMENSIONS.length);
    await submit(resumed, "add-missing-obligation", [
      {
        id: "missing-obligation",
        raw: call("obligation", {
          sourceLocators: ["src/manual.md:1-2"],
          statement: "The source declares a deterministic default.",
          evidenceClass: "source-observation",
          uncertainty: "The source may be incomplete.",
          dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
        }),
      },
    ]);
    await submit(resumed, "reclose", [
      { id: "reclose", raw: call("proposal-note", { limitations: [], closed: true }) },
    ]);
    expect(await resumed.finish()).toMatchObject({ completeness: "bounded-not-proven" });
  });
});
