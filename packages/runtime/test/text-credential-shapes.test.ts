// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { containsTokenShapedText } from "../scripts/docsfab-preflight.mjs";
import { containsCredentialDeep } from "../src/host-invoker/contracts.js";
import { assertLiveAgentAnswerProjectable } from "../src/host-invoker/live-agent-turn.js";
import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  DOCUMENT_CREDENTIAL_SHAPES,
  TEXT_CREDENTIAL_SHAPES,
  containsTextCredentialShape,
} from "../src/security/text-credential-shapes.js";

// Fixtures are assembled at run time; no source line carries a credential.
const upper = (length: number) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".slice(0, length);
const TEXT_ONLY_FAMILIES: readonly (readonly [name: string, refused: string, admitted: string])[] =
  [
    ["bearer value", ["Bearer", "b".repeat(16)].join(" "), ["Bearer", "b".repeat(15)].join(" ")],
    [
      "lower-case bearer value",
      ["bearer", "b".repeat(16)].join(" "),
      ["bearer", "b".repeat(15)].join(" "),
    ],
    [
      "JWT",
      [`eyJ${"Q".repeat(10)}`, "Q".repeat(10), "sig"].join("."),
      [`eyJ${"Q".repeat(10)}`, "Q".repeat(9), "sig"].join("."),
    ],
    [
      "PEM private-key banner",
      ["-----BEGIN RSA", "PRIVATE", "KEY-----"].join(" "),
      ["-----BEGIN RSA", "PUBLIC", "KEY-----"].join(" "),
    ],
    [
      "AWS long-term access-key identifier",
      ["AK", "IA", upper(16)].join(""),
      ["AK", "IA", upper(15)].join(""),
    ],
    [
      "AWS temporary access-key identifier",
      ["AS", "IA", upper(16)].join(""),
      ["AS", "IA", upper(15)].join(""),
    ],
  ];

/** Whether the answer check flags the text. It never refuses a shape (#1807). */
function answerCheckFlags(text: string): boolean {
  return assertLiveAgentAnswerProjectable(text).length > 0;
}

/** The hosted wire screen's verdict and what it recorded. */
function wireScreen(value: unknown) {
  const { result, findings } = collectCredentialFindings(() =>
    containsCredentialDeep(value, "hosted-test:field"),
  );
  return { refused: result, rules: findings.map((finding) => finding.rule) };
}

describe("the shared credential-shape lists", () => {
  it("are frozen, nested, and free of stateful flags", () => {
    expect(Object.isFrozen(DOCUMENT_CREDENTIAL_SHAPES)).toBe(true);
    expect(Object.isFrozen(TEXT_CREDENTIAL_SHAPES)).toBe(true);
    expect(DOCUMENT_CREDENTIAL_SHAPES).toHaveLength(8);
    expect(TEXT_CREDENTIAL_SHAPES).toHaveLength(12);
    expect(TEXT_CREDENTIAL_SHAPES.slice(0, 8)).toEqual([...DOCUMENT_CREDENTIAL_SHAPES]);
    // AWS key ids are uppercase; an ordinary word must not match.
    expect(containsTextCredentialShape("The AsiaPacificOperation team")).toBe(false);
    expect(answerCheckFlags("The AsiaPacificOperation team")).toBe(false);
    // A `g` or `y` flag would make `.test` stateful and skip matches.
    expect(TEXT_CREDENTIAL_SHAPES.filter((shape) => shape.global || shape.sticky)).toEqual([]);
  });

  it.each(TEXT_ONLY_FAMILIES)(
    "the answer check flags a %s and the MR-text scan matches it; the hosted wire screen records nothing",
    (_name, refused, admitted) => {
      for (const [value, expected] of [
        [refused, true],
        [admitted, false],
      ] as const) {
        const text = `The value ${value} appears here.`;
        expect(containsTextCredentialShape(text)).toBe(expected);
        expect(answerCheckFlags(text)).toBe(expected);
        expect(containsTokenShapedText(text)).toBe(expected);
        expect(wireScreen({ field: text })).toEqual({ refused: false, rules: [] });
      }
    },
  );

  it("admits a documentation patch and run record quoting example credentials at the hosted wire screen", () => {
    // terminal.ts screens `patch` and `runtimeRecord` with containsCredentialDeep.
    // Documentation legitimately quotes these published placeholder values.
    const awsExample = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
    const bearerPlaceholder = ["Bearer", "your-access-token-here"].join(" ");
    const patch = [
      "diff --git a/docs/auth.md b/docs/auth.md",
      "+++ b/docs/auth.md",
      "@@ -1 +1,2 @@",
      `+Set \`AWS_ACCESS_KEY_ID=${awsExample}\`-style ids in the example profile.`,
      `+Send \`Authorization: ${bearerPlaceholder}\` with each request.`,
    ].join("\n");
    expect(wireScreen(patch)).toEqual({ refused: false, rules: [] });
    expect(wireScreen({ runtimeRecord: { answer: `${awsExample} ${bearerPlaceholder}` } })).toEqual(
      { refused: false, rules: [] },
    );
    // The same text matches the text list, which shared-channel screens flag.
    expect(containsTextCredentialShape(awsExample)).toBe(true);
    expect(containsTextCredentialShape(bearerPlaceholder)).toBe(true);
    // Adjacent condition: a document-list shape is flagged at the wire, not refused.
    expect(wireScreen(`+token: ${"v".repeat(12)}`)).toEqual({
      refused: false,
      rules: ["credential.assigned-secret"],
    });
  });
});
