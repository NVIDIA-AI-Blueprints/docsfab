// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { auditJudgmentRowKeys } from "../src/execution/judgment-row-key-audit.js";
import { isJudgmentRowKeyAudit } from "../src/execution/judgment-row-key-audit-contract.js";
import { isDeclaredResponseContractKey } from "../src/execution/response-contract-vocabulary.js";

// Synthetic, identifier-shaped model keys; never named in the audit.
const HEX_KEY = "a123456789abcdef0123456789abcdef01234567";
const PROSE_KEY = "the_customer_password_is_Tr0ub4dor3";

function judgment(overrides: {
  issue?: Record<string, unknown>;
  obligation?: Record<string, unknown>;
  replacement?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    verdict: "needs-revision",
    coverage: [],
    issueJudgments: [
      {
        id: "TECH-001",
        severity: "major",
        category: "technical_accuracy",
        location: "README.md:1",
        obligationIds: ["OBL-1"],
        ...overrides.issue,
      },
    ],
    obligationJudgments: [
      {
        obligationId: "OBL-1",
        disposition: "retained",
        documentationDisposition: "omitted",
      },
      {
        obligationId: "OBL-2",
        disposition: "refined",
        reason: "Refined against the cited source.",
        replacements: [
          {
            statement: "A statement.",
            documentationDisposition: "omitted",
            uncertainty: "None.",
            ...overrides.replacement,
          },
        ],
        ...overrides.obligation,
      },
    ],
  });
}

const clean = { rows: 0, undeclaredKeys: 0, namedUndeclaredKeys: [] };

describe("judgment row key audit (#1178)", () => {
  it("counts nothing on a reply that uses only declared row keys", () => {
    expect(auditJudgmentRowKeys(judgment({}), isDeclaredResponseContractKey)).toEqual({
      schemaVersion: 1,
      issueJudgments: { ...clean, rows: 1 },
      obligationJudgments: { ...clean, rows: 2 },
      replacements: { ...clean, rows: 1 },
    });
  });

  it.each([
    ["issueJudgments", { issue: { sourceLocators: [], [HEX_KEY]: 1 } }],
    ["obligationJudgments", { obligation: { sourceLocators: [], [HEX_KEY]: 1 } }],
    ["replacements", { replacement: { sourceLocators: [], [HEX_KEY]: 1 } }],
  ] as const)(
    "counts undeclared %s keys and names only contract-declared ones",
    (type, overrides) => {
      const audit = auditJudgmentRowKeys(judgment(overrides), isDeclaredResponseContractKey)!;
      expect(audit[type]).toMatchObject({
        undeclaredKeys: 2,
        namedUndeclaredKeys: ["sourceLocators"],
      });
      for (const other of ["issueJudgments", "obligationJudgments", "replacements"] as const) {
        if (other !== type) expect(audit[other].undeclaredKeys).toBe(0);
      }
      expect(JSON.stringify(audit)).not.toContain(HEX_KEY);
      expect(isJudgmentRowKeyAudit(audit)).toBe(true);
    },
  );

  it("names a retired issueIds link on obligation and replacement rows as undeclared (#1342)", () => {
    const audit = auditJudgmentRowKeys(
      judgment({ obligation: { issueIds: [] }, replacement: { issueIds: ["TECH-001"] } }),
      isDeclaredResponseContractKey,
    )!;
    expect(audit.obligationJudgments).toMatchObject({
      undeclaredKeys: 1,
      namedUndeclaredKeys: ["issueIds"],
    });
    expect(audit.replacements).toMatchObject({
      undeclaredKeys: 1,
      namedUndeclaredKeys: ["issueIds"],
    });
  });

  it("returns nothing for a reply that is not a judgment, and never throws", () => {
    expect(auditJudgmentRowKeys('{"review":{}}', isDeclaredResponseContractKey)).toBeUndefined();
    expect(auditJudgmentRowKeys("not json", isDeclaredResponseContractKey)).toBeUndefined();
  });

  it("refuses a forged audit that names a non-identifier or credential-shaped key", () => {
    const audit = auditJudgmentRowKeys(judgment({}), isDeclaredResponseContractKey)!;
    for (const name of [PROSE_KEY.replace(/_/gu, " "), `ghp_${"Zz09".repeat(9)}`]) {
      expect(
        isJudgmentRowKeyAudit({
          ...audit,
          issueJudgments: { rows: 1, undeclaredKeys: 1, namedUndeclaredKeys: [name] },
        }),
      ).toBe(false);
    }
    expect(isJudgmentRowKeyAudit({ ...audit, extra: 1 })).toBe(false);
  });
});
