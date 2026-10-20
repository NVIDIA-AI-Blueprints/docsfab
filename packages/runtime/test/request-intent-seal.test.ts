// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The sealed RequestIntentV1 artifact (R10): verification recomputes the
 * request digest from the instruction and re-derives every quote and the
 * seal; it never trusts a self-declared field.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  REQUEST_INTENT_KIND,
  requestInstructionSha256,
  RequestIntentContractError,
  verifyRequestIntentDigest,
  requestIntentWriteSet,
  type RequestIntentBody,
  type RequestIntentV1,
} from "../src/request-intent/index.js";
import { sealRequestIntent } from "../src/request-intent/seal.js";
import {
  edited,
  interpret,
  question,
  UPDATE_HOST,
  UPDATE_INSTRUCTION,
  updateProposal,
} from "./helpers/request-intent-fixture.js";

function admitted(
  proposal = updateProposal(),
  instruction = UPDATE_INSTRUCTION,
  host = UPDATE_HOST,
): RequestIntentV1 {
  const result = interpret(proposal, instruction, host);
  if (result.outcome !== "admitted") throw new Error(`Expected admission, got ${result.outcome}.`);
  return result.intent;
}

function verifyFailure(value: unknown, instruction = UPDATE_INSTRUCTION): string | undefined {
  try {
    verifyRequestIntentDigest(value, instruction);
  } catch (error) {
    expect(error).toBeInstanceOf(RequestIntentContractError);
    return (error as RequestIntentContractError).code;
  }
  return undefined;
}

function tampered(intent: RequestIntentV1, edit: (copy: Record<string, unknown>) => void) {
  const copy = JSON.parse(JSON.stringify(intent)) as Record<string, unknown>;
  edit(copy);
  return copy;
}

/**
 * The seal is an unkeyed digest, so anyone who can write a run record can
 * re-seal an edited body. These forgeries carry a valid digest, so only the
 * verifier's own shape checks stand between them and a consumer.
 */
function resealed(intent: RequestIntentV1, edit: (body: Record<string, unknown>) => void) {
  const body = JSON.parse(JSON.stringify(intent)) as Record<string, unknown>;
  delete body.schemaVersion;
  delete body.kind;
  delete body.digest;
  edit(body);
  return JSON.parse(JSON.stringify(sealRequestIntent(body as unknown as RequestIntentBody)));
}

type Body = Record<string, unknown>;
type Entry = Record<string, unknown>;
const firstTarget = (body: Body) => (body.targets as Entry[])[0]!;
const targetQuote = (body: Body) => firstTarget(body).quote;

describe("request-intent seal and verification", () => {
  it("round-trips through JSON and verifies against its instruction", () => {
    const intent = admitted();
    expect(intent).toMatchObject({
      schemaVersion: 1,
      kind: REQUEST_INTENT_KIND,
    });
    expect(intent.instructionSha256).toBe(
      createHash("sha256").update(UPDATE_INSTRUCTION.normalize("NFC")).digest("hex"),
    );
    const verified = verifyRequestIntentDigest(
      JSON.parse(JSON.stringify(intent)),
      UPDATE_INSTRUCTION,
    );
    expect(verified).toEqual(intent);
  });

  it("verifies the sealed intent an advisory carries with the model's question", () => {
    const result = interpret(
      edited(updateProposal(), (p) => void (p.questions = [question()])),
      UPDATE_INSTRUCTION,
      UPDATE_HOST,
    );
    if (result.outcome !== "advisory") throw new Error("Expected the advisory arm.");
    expect(result.intent.question).not.toBeNull();
    expect(
      verifyRequestIntentDigest(JSON.parse(JSON.stringify(result.intent)), UPDATE_INSTRUCTION),
    ).toEqual(result.intent);
  });

  it("is frozen, so a recorded intent cannot be edited in place", () => {
    const intent = admitted();
    expect(() => {
      (intent as { operation: string }).operation = "create";
    }).toThrow(TypeError);
    expect(() => {
      (intent.targets[0]!.quote as { text: string }).text = "edited";
    }).toThrow(TypeError);
  });

  it("refuses a different instruction", () => {
    expect(verifyFailure(admitted(), `${UPDATE_INSTRUCTION} Also publish it.`)).toBe(
      "sealed-instruction-mismatch",
    );
  });

  it("refuses a tampered request digest, with or without a recomputed seal", () => {
    const intent = admitted();
    const forge = (copy: Record<string, unknown>) => void (copy.instructionSha256 = "0".repeat(64));
    expect(verifyFailure(tampered(intent, forge))).toBe("sealed-instruction-mismatch");
    expect(verifyFailure(resealed(intent, forge))).toBe("sealed-instruction-mismatch");
  });

  it("refuses an intent hashed over the raw NFD instruction", () => {
    const nfd = "Update the café page to match the current implementation.";
    const intent = admitted(
      edited(updateProposal(), (p) => {
        p.preserve = [];
        p.authorityPreference = { preference: "unspecified", quote: null };
        (p.targets as Record<string, unknown>[])[0]!.quote = "Update the café page";
      }),
      nfd,
    );
    expect(intent.instructionSha256).toBe(requestInstructionSha256(nfd));
    expect(verifyRequestIntentDigest(intent, nfd)).toEqual(intent);
    const rawHash = createHash("sha256").update(nfd).digest("hex");
    expect(rawHash).not.toBe(intent.instructionSha256);
    expect(
      verifyFailure(
        tampered(intent, (copy) => (copy.instructionSha256 = rawHash)),
        nfd,
      ),
    ).toBe("sealed-instruction-mismatch");
  });

  it.each([
    ["the operation", (copy: Record<string, unknown>) => (copy.operation = "create")],
    [
      "a target path",
      (copy: Record<string, unknown>) =>
        ((copy.targets as Record<string, unknown>[])[0]!.path = "docs/index.md"),
    ],
    [
      "a target role",
      (copy: Record<string, unknown>) =>
        ((copy.targets as Record<string, unknown>[])[0]!.role = "companion-index"),
    ],
    [
      "a target origin",
      (copy: Record<string, unknown>) =>
        ((copy.targets as Record<string, unknown>[])[0]!.chosenFrom = "named"),
    ],
    ["a preserve entry", (copy: Record<string, unknown>) => (copy.preserve as unknown[]).pop()],
    [
      "the authority preference",
      (copy: Record<string, unknown>) =>
        ((copy.authorityPreference as Record<string, unknown>).preference = "documentation"),
    ],
    ["the question", (copy: Record<string, unknown>) => (copy.question = question())],
  ])("refuses a changed %s through the seal", (_name, edit) => {
    expect(verifyFailure(tampered(admitted(), edit))).toBe("sealed-digest-mismatch");
  });

  it("refuses a quote that is not the instruction text at its offsets", () => {
    const intent = admitted();
    const moved = tampered(intent, (copy) => {
      const quote = (copy.targets as { quote: { start: number; end: number } }[])[0]!.quote;
      quote.start += 1;
      quote.end += 1;
    });
    expect(verifyFailure(moved)).toBe("sealed-quote-mismatch");
  });

  it("keeps its digest out of the digested body, so the digest field alone changes nothing else", () => {
    const intent = admitted();
    expect(verifyFailure(tampered(intent, (copy) => (copy.digest = "f".repeat(64))))).toBe(
      "sealed-digest-mismatch",
    );
    expect(verifyFailure(tampered(intent, (copy) => delete copy.digest))).toBe("sealed-shape");
    expect(verifyFailure(tampered(intent, (copy) => (copy.extra = true)))).toBe("sealed-shape");
  });

  it("refuses an instruction that is not a string as a host fault", () => {
    expect(verifyFailure(admitted(), null as never)).toBe("host-input-invalid");
  });

  it("verifies an unedited re-seal, so each forgery below fails on its edit alone", () => {
    const intent = admitted();
    expect(
      verifyRequestIntentDigest(
        resealed(intent, () => undefined),
        UPDATE_INSTRUCTION,
      ),
    ).toEqual(intent);
  });

  it.each([
    ["target path", (body: Body, path: string) => void (firstTarget(body).path = path)],
    [
      "source path",
      (body: Body, path: string) => void (body.sources = [{ path, quote: targetQuote(body) }]),
    ],
    [
      "exclusion path",
      (body: Body, path: string) => void (body.exclusions = [{ path, quote: targetQuote(body) }]),
    ],
  ])("refuses a re-sealed %s outside the path grammar", (_name, place) => {
    const intent = admitted();
    for (const path of ["../outside.md", "/etc/passwd", "docs//x.md", "docs/x.md/"]) {
      const forged = resealed(intent, (body) => place(body, path));
      expect(verifyFailure(forged), path).toBe("sealed-shape");
    }
    // Adjacent: the same field with a grammatical path verifies.
    const valid = resealed(intent, (body) => place(body, "docs/troubleshooting.md"));
    expect(verifyFailure(valid)).toBeUndefined();
  });

  it("refuses a re-sealed outside target before the write set is computed", () => {
    const forged = resealed(admitted(), (body) => void (firstTarget(body).path = "../outside.md"));
    expect(() =>
      requestIntentWriteSet(verifyRequestIntentDigest(forged, UPDATE_INSTRUCTION)),
    ).toThrow(expect.objectContaining({ code: "sealed-shape" }));
  });

  it("refuses a re-sealed unspecified preference that carries a quote", () => {
    const forged = resealed(admitted(), (body) => {
      (body.authorityPreference as Entry).preference = "unspecified";
    });
    expect(verifyFailure(forged)).toBe("sealed-shape");
  });

  it("refuses a re-sealed stated preference without a quote", () => {
    const forged = resealed(admitted(), (body) => {
      (body.authorityPreference as Entry).quote = null;
    });
    expect(verifyFailure(forged)).toBe("sealed-shape");
    // Adjacent: unspecified without a quote is the one quote-free preference.
    const unspecified = resealed(admitted(), (body) => {
      body.authorityPreference = { preference: "unspecified", quote: null };
    });
    expect(verifyFailure(unspecified)).toBeUndefined();
  });

  it("refuses a re-sealed question with a duplicate option", () => {
    const forged = resealed(admitted(), (body) => {
      body.question = question({ options: ["docs/cli.md", "docs/cli.md"] });
    });
    expect(verifyFailure(forged)).toBe("sealed-shape");
  });

  it("refuses a re-sealed question whose default is not an option", () => {
    const forged = resealed(admitted(), (body) => {
      body.question = question({ recommendedDefault: "docs/troubleshooting.md" });
    });
    expect(verifyFailure(forged)).toBe("sealed-shape");
    // Adjacent: the same question with its default among the options verifies.
    const valid = resealed(admitted(), (body) => void (body.question = question()));
    expect(verifyFailure(valid)).toBeUndefined();
  });
});
