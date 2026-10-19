// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { OUTPUT_RECORD_CONTRACTS } from "../src/contracts/model-output.js";
import { createSourceObligationAnswerRecordSession as createSourceObligationAnswerRecordSessionRaw } from "../src/harness/source-obligation-answer-records.js";
import { validateSourceObligationRecordForAdmission } from "../src/workflow-execution/source-obligation.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/review-response.js";
import { grantedToolsForStep } from "../src/harness/pi-tool-confine.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

const createSourceObligationAnswerRecordSession = (
  input: Omit<
    Parameters<typeof createSourceObligationAnswerRecordSessionRaw>[0],
    "continuationIdentitySha256"
  > & { readonly continuationIdentitySha256?: string },
) =>
  createSourceObligationAnswerRecordSessionRaw({
    ...input,
    continuationIdentitySha256: input.continuationIdentitySha256 ?? "test-step-evidence",
  });

const obligation = {
  sourceLocators: ["src/manual.md:1-2"],
  statement: "The source declares a deterministic default.",
  evidenceClass: "source-observation",
  uncertainty: "The source may be stale.",
  dimensionKey: TECHNICAL_FACT_DIMENSIONS[0],
};

function dimensionRecord(status: "applicable" | "not-applicable" | "unverified" = "unverified") {
  return {
    status,
    reason: "Recorded from the available source evidence.",
    sourceLocators: status === "not-applicable" ? ["src/manual.md:1-2"] : [],
    obligations: [],
  };
}

function call(type: string, record: unknown, key?: string): string {
  return JSON.stringify({ type, ...(key === undefined ? {} : { key }), record });
}

async function submit(
  session: ReturnType<typeof createSourceObligationAnswerRecordSession>,
  batchId: string,
  args: readonly { readonly id: string; readonly raw: string }[],
) {
  await session.capability.prepareBatch({
    batchId,
    toolCalls: args.map(({ id, raw }) => ({ toolCallId: id, rawArguments: raw })),
    authorizedToolCallIds: args.map(({ id }) => id),
  });
  const receipts = new Map(args.map(({ id }) => [id, session.capability.receipt(id)]));
  await session.capability.settle({
    batchId,
    toolCallIds: args.map(({ id }) => id),
    authorizedToolCallIds: args.map(({ id }) => id),
    successfulToolCallIds: args.flatMap(({ id }) =>
      receipts.get(id)?.status === "refused" ? [] : [id],
    ),
    failedToolCallIds: args.flatMap(({ id }) =>
      receipts.get(id)?.status === "refused" ? [id] : [],
    ),
  });
  return receipts;
}

describe("S2 source-obligation records adapter", () => {
  it("uses the production declaration and assembles independent obligation rows into host-linked dimensions", async () => {
    expect(OUTPUT_RECORD_CONTRACTS["source-obligation"].version).toBe(3);
    const session = createSourceObligationAnswerRecordSession({ validateRecord: () => {} });
    const dimensions = TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
      id: `dimension-${index}`,
      raw: call("dimension", dimensionRecord(index === 0 ? "applicable" : "unverified"), dimension),
    }));
    const dimensionReceipts = await submit(session, "dimensions", dimensions);
    expect(
      [...dimensionReceipts.values()].every((receipt) => receipt.status === "admitted"),
      JSON.stringify([...dimensionReceipts]),
    ).toBe(true);

    const first = await submit(session, "obligation-one", [
      { id: "obligation-one", raw: call("obligation", obligation) },
    ]);
    expect(first.get("obligation-one")?.status, JSON.stringify(first.get("obligation-one"))).toBe(
      "admitted",
    );
    expect(first.get("obligation-one")?.key).toBe("O-1");

    const duplicate = await submit(session, "obligation-duplicate", [
      { id: "obligation-duplicate", raw: call("obligation", obligation) },
    ]);
    expect(duplicate.get("obligation-duplicate")).toMatchObject({
      status: "refused",
      code: "answer-record-duplicate",
    });

    const closed = await submit(session, "close", [
      { id: "close", raw: call("proposal-note", { limitations: [], closed: true }) },
    ]);
    expect(closed.get("close")?.status).toBe("admitted");
    const late = await submit(session, "late", [
      {
        id: "late",
        raw: call("obligation", {
          ...obligation,
          statement: "A late independent statement.",
        }),
      },
    ]);
    expect(late.get("late")).toMatchObject({
      status: "refused",
      code: "answer-record-closed",
      retry: "terminal",
    });

    const proposal = await session.finish();
    expect(proposal.completeness).toBe("bounded-not-proven");
    expect(proposal.dimensions[0]?.dimension).toBe(TECHNICAL_FACT_DIMENSIONS[0]);
    expect(proposal.dimensions[0]?.obligations).toEqual([
      expect.objectContaining({
        id: "OBL-INPUT-REPRESENTATIONS-1",
        dimension: TECHNICAL_FACT_DIMENSIONS[0],
        statement: obligation.statement,
      }),
    ]);
    expect(proposal.dimensions[0]?.obligations[0]).not.toHaveProperty("dimensionKey");
  });

  it("refuses unknown parents and semantic child/status conflicts before issuing a successful receipt", async () => {
    const session = createSourceObligationAnswerRecordSession({
      validateRecord(type, value, parentStatus) {
        if (type === "obligation" && parentStatus) {
          validateSourceObligationRecordForAdmission(
            type,
            value,
            { workflow: { name: "review-documentation" } } as never,
            parentStatus,
          );
        }
      },
    });
    await submit(session, "parent", [
      {
        id: "parent",
        raw: call("dimension", dimensionRecord("not-applicable"), TECHNICAL_FACT_DIMENSIONS[0]),
      },
    ]);
    const semantic = await submit(session, "semantic-invalid", [
      { id: "semantic-invalid", raw: call("obligation", obligation) },
    ]);
    expect(semantic.get("semantic-invalid")).toMatchObject({
      status: "refused",
      code: "dimension-not-applicable-with-obligations",
      retry: "model-correctable",
    });
    expect(session.snapshot().rows.has("obligation\u0000O-1")).toBe(false);

    const unknown = await submit(session, "unknown-parent", [
      {
        id: "unknown-parent",
        raw: call("obligation", { ...obligation, dimensionKey: TECHNICAL_FACT_DIMENSIONS[1] }),
      },
    ]);
    expect(unknown.get("unknown-parent")).toMatchObject({
      status: "refused",
      code: "invalid-value",
      retry: "model-correctable",
    });
    expect(session.snapshot().rows.has("obligation\u0000O-1")).toBe(false);
  });

  it("charges only returned semantic refusals and reaches the settled per-key exhaustion bound", async () => {
    const session = createSourceObligationAnswerRecordSession({
      validateRecord(type, value, parentStatus) {
        if (type === "obligation" && parentStatus) {
          validateSourceObligationRecordForAdmission(
            type,
            value,
            { workflow: { name: "review-documentation" } } as never,
            parentStatus,
          );
        }
      },
    });
    await submit(session, "parent", [
      {
        id: "parent",
        raw: call("dimension", dimensionRecord("unverified"), TECHNICAL_FACT_DIMENSIONS[0]),
      },
    ]);
    const max = session.snapshot().plan.maxRefusalsPerKey;
    let last: Awaited<ReturnType<typeof submit>> | undefined;
    for (let index = 0; index <= max; index += 1) {
      last = await submit(session, `semantic-refusal-${index}`, [
        { id: `refusal-${index}`, raw: call("obligation", obligation) },
      ]);
    }
    expect(last?.get(`refusal-${max}`)).toMatchObject({
      status: "refused",
      code: "answer-record-exhausted",
      retry: "terminal",
    });
    expect(session.snapshot().exhausted).toEqual({ type: "obligation", key: null });
    expect(session.snapshot().rows.has("obligation\u0000O-1")).toBe(false);
  });

  it("refuses a parent status replacement that would invalidate settled child rows", async () => {
    const session = createSourceObligationAnswerRecordSession({ validateRecord: () => {} });
    await submit(session, "applicable-parent", [
      {
        id: "dimension",
        raw: call("dimension", dimensionRecord("applicable"), TECHNICAL_FACT_DIMENSIONS[0]),
      },
    ]);
    await submit(session, "child", [{ id: "child", raw: call("obligation", obligation) }]);
    const replaced = await submit(session, "parent-replacement", [
      {
        id: "replacement",
        raw: call("dimension", dimensionRecord("unverified"), TECHNICAL_FACT_DIMENSIONS[0]),
      },
    ]);
    expect(replaced.get("replacement")).toMatchObject({
      status: "refused",
      code: "invalid-value",
      location: "$.dimensions[].status",
      retry: "model-correctable",
    });
    expect(
      session.snapshot().rows.get(`dimension\u0000${TECHNICAL_FACT_DIMENSIONS[0]}`)?.payload,
    ).toMatchObject({ status: "applicable" });
    expect(session.snapshot().rows.has("obligation\u0000O-1")).toBe(true);
  });

  it("requires separate settled closure and refuses final missing work", async () => {
    const session = createSourceObligationAnswerRecordSession({ validateRecord: () => {} });
    await expect(session.finish()).rejects.toThrow(/incomplete/u);
    await submit(session, "dimension", [
      {
        id: "dimension",
        raw: call("dimension", dimensionRecord(), TECHNICAL_FACT_DIMENSIONS[0]),
      },
    ]);
    const sameBatch = await submit(session, "same-batch-close", [
      {
        id: "same-batch-obligation",
        raw: call("obligation", obligation),
      },
      {
        id: "same-batch-note",
        raw: call("proposal-note", { limitations: [], closed: true }),
      },
    ]);
    expect(sameBatch.get("same-batch-note")).toMatchObject({
      status: "refused",
      code: "answer-record-closed",
      retry: "terminal",
    });
  });

  it("does not admit a semantically valid row when the tool call failed before settlement", async () => {
    const session = createSourceObligationAnswerRecordSession({ validateRecord: () => {} });
    const raw = call("dimension", dimensionRecord(), TECHNICAL_FACT_DIMENSIONS[0]);
    await session.capability.prepareBatch({
      batchId: "failed-dimension-call",
      toolCalls: [{ toolCallId: "failed-dimension", rawArguments: raw }],
      authorizedToolCallIds: ["failed-dimension"],
    });
    expect(session.capability.receipt("failed-dimension").status).toBe("admitted");
    await session.capability.settle({
      batchId: "failed-dimension-call",
      toolCallIds: ["failed-dimension"],
      authorizedToolCallIds: ["failed-dimension"],
      successfulToolCallIds: [],
      failedToolCallIds: [],
    });
    expect(session.snapshot().rows.has(`dimension\u0000${TECHNICAL_FACT_DIMENSIONS[0]}`)).toBe(
      false,
    );
  });

  it("does not charge a refusal unless its authorized refused tool execution was observed", async () => {
    const session = createSourceObligationAnswerRecordSession({
      validateRecord(type, value, parentStatus) {
        if (type === "obligation" && parentStatus) {
          validateSourceObligationRecordForAdmission(
            type,
            value,
            { workflow: { name: "review-documentation" } } as never,
            parentStatus,
          );
        }
      },
    });
    await submit(session, "parent", [
      {
        id: "parent",
        raw: call("dimension", dimensionRecord("unverified"), TECHNICAL_FACT_DIMENSIONS[0]),
      },
    ]);
    const raw = call("obligation", obligation);
    await session.capability.prepareBatch({
      batchId: "not-executed-refusal",
      toolCalls: [{ toolCallId: "refused-but-not-run", rawArguments: raw }],
      authorizedToolCallIds: ["refused-but-not-run"],
    });
    expect(session.capability.receipt("refused-but-not-run").status).toBe("refused");
    await session.capability.settle({
      batchId: "not-executed-refusal",
      toolCallIds: ["refused-but-not-run"],
      authorizedToolCallIds: ["refused-but-not-run"],
      successfulToolCallIds: [],
      failedToolCallIds: [],
    });
    expect(session.snapshot().refusals.size).toBe(0);

    await session.capability.prepareBatch({
      batchId: "unauthorized-refusal",
      toolCalls: [{ toolCallId: "unauthorized", rawArguments: raw }],
      authorizedToolCallIds: [],
    });
    await session.capability.settle({
      batchId: "unauthorized-refusal",
      toolCallIds: ["unauthorized"],
      authorizedToolCallIds: [],
      successfulToolCallIds: [],
      failedToolCallIds: [],
    });
    expect(session.snapshot().refusals.size).toBe(0);
  });

  it("exposes the source tool only through an explicit exact-step capability", () => {
    const workflow = getWorkflow("review-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!;
    const args = [
      workflow,
      step,
      false,
      false,
      false,
      false,
      false,
      undefined,
      undefined,
      false,
    ] as const;
    const disabled = grantedToolsForStep(...args);
    const enabled = grantedToolsForStep(...args, false, true);
    expect(disabled).not.toContain("submit_answer_record");
    expect(enabled).toContain("submit_answer_record");
  });
});
