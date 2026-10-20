// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BEARER_VALUE_RULE_ID,
  collectCredentialFindings,
  collectCredentialFindingsAsync,
  credentialFindingsAt,
  documentShapeRuleIds,
  isShowableCredentialFinding,
  recordCredentialFindings,
  ruleIdsInValue,
  screenCredentialText,
  screenCredentialValue,
  textShapeRuleIds,
  tokenPrefixRuleIds,
} from "../src/security/credential-shape-findings.js";
import { sortCredentialFindings } from "../src/security/credential-findings.js";
import { SECURITY_RULE_IDS } from "../src/security/repository-scanner.js";
import { TEXT_CREDENTIAL_SHAPES } from "../src/security/text-credential-shapes.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

// Shaped fixtures, assembled at run time so no source line holds one.
const GITLAB = ["glpat", plantedCredentialValue(3, 24)].join("-");
const ASSIGNMENT = ["token", plantedCredentialValue(5, 16)].join("=");
const BEARER = ["Bearer", plantedCredentialValue(7, 24)].join(" ");
const AWS = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
const PEM = ["-----BEGIN RSA", "PRIVATE", "KEY-----"].join(" ");
const JWT_PREFIX = [`eyJ${"Q".repeat(10)}`, "Q".repeat(10), "sig"].join(".");

describe("credential shape findings", () => {
  afterEach(() => {
    clearPlantedCredential();
    vi.restoreAllMocks();
  });

  it("names one scanner rule for every shape in both shared lists", () => {
    const families: readonly (readonly [string, string, "document" | "text"])[] = [
      [GITLAB, SECURITY_RULE_IDS.gitlabToken, "document"],
      [
        ["ghp", plantedCredentialValue(11, 36)].join("_"),
        SECURITY_RULE_IDS.githubToken,
        "document",
      ],
      [
        ["xoxb", plantedCredentialValue(13, 24)].join("-"),
        SECURITY_RULE_IDS.slackToken,
        "document",
      ],
      [
        ["xoxe", plantedCredentialValue(17, 16)].join("-"),
        SECURITY_RULE_IDS.slackToken,
        "document",
      ],
      [
        ["xapp", plantedCredentialValue(19, 16)].join("-"),
        SECURITY_RULE_IDS.slackToken,
        "document",
      ],
      [
        ["nvapi", plantedCredentialValue(23, 24)].join("-"),
        SECURITY_RULE_IDS.nvidiaApiKey,
        "document",
      ],
      [
        ["sk", plantedCredentialValue(29, 24)].join("-"),
        SECURITY_RULE_IDS.openAiApiKey,
        "document",
      ],
      [ASSIGNMENT, SECURITY_RULE_IDS.assignedSecret, "document"],
      [BEARER, BEARER_VALUE_RULE_ID, "text"],
      [JWT_PREFIX, SECURITY_RULE_IDS.jwt, "text"],
      [PEM, SECURITY_RULE_IDS.privateKey, "text"],
      [AWS, SECURITY_RULE_IDS.awsAccessKey, "text"],
    ];
    // The probes reach every shape, so every shape's rule is checked below.
    for (const shape of TEXT_CREDENTIAL_SHAPES) {
      expect(
        families.some(([probe]) => shape.test(probe)),
        shape.source,
      ).toBe(true);
    }
    for (const [probe, rule, list] of families) {
      expect(textShapeRuleIds(`see ${probe} here`), rule).toEqual([rule]);
      expect(documentShapeRuleIds(`see ${probe} here`), rule).toEqual(
        list === "document" ? [rule] : [],
      );
    }
    expect(documentShapeRuleIds(`${GITLAB} ${ASSIGNMENT}`)).toEqual([
      SECURITY_RULE_IDS.assignedSecret,
      SECURITY_RULE_IDS.gitlabToken,
    ]);
    expect(textShapeRuleIds("An ordinary sentence about tokens and keys.")).toEqual([]);
  });

  it("tests issuer prefixes anywhere or at the start, with or without case", () => {
    // A prefix inside a word is not one: the screen this replaced matched it.
    expect(tokenPrefixRuleIds("task-list")).toEqual([]);
    expect(tokenPrefixRuleIds("TASK-list", { ignoreCase: true })).toEqual([]);
    expect(tokenPrefixRuleIds("Label GLPAT-x", { ignoreCase: true })).toEqual([
      SECURITY_RULE_IDS.gitlabToken,
    ]);
    expect(tokenPrefixRuleIds("Label GLPAT-x")).toEqual([]);
    expect(tokenPrefixRuleIds("sk-docs-workstream", { anchored: true })).toEqual([
      SECURITY_RULE_IDS.openAiApiKey,
    ]);
    expect(tokenPrefixRuleIds("docs-sk-workstream", { anchored: true })).toEqual([]);
    expect(tokenPrefixRuleIds("label glpat-x and xoxb-y")).toEqual([
      SECURITY_RULE_IDS.gitlabToken,
      SECURITY_RULE_IDS.slackToken,
    ]);
  });

  it("collects rule ids from every string value of a structure, not its keys", () => {
    const value: Record<string, unknown> = { nested: [{ note: GITLAB }], [ASSIGNMENT]: 1 };
    value.self = value;
    expect(ruleIdsInValue(value, documentShapeRuleIds)).toEqual([SECURITY_RULE_IDS.gitlabToken]);
  });

  it("gives every open scope a recorded finding, synchronously and across awaits", async () => {
    const inner = credentialFindingsAt("inner:field", [SECURITY_RULE_IDS.jwt]);
    const outer = collectCredentialFindings(() => {
      recordCredentialFindings(credentialFindingsAt("outer:field", [SECURITY_RULE_IDS.jwt]));
      return collectCredentialFindings(() => recordCredentialFindings(inner)).findings;
    });
    expect(outer.result).toEqual(inner);
    expect(outer.findings.map((finding) => finding.location)).toEqual([
      "inner:field",
      "outer:field",
    ]);
    const asynchronous = await collectCredentialFindingsAsync(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      recordCredentialFindings(inner);
      return "done";
    });
    expect(asynchronous).toEqual({ result: "done", findings: inner });
  });

  it("writes a finding with no open scope to stderr as one content-free line", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const recorded = screenCredentialText(`see ${GITLAB}`, "unscoped:field", textShapeRuleIds);
    expect(recorded).toBeNull();
    expect(writes).toEqual([
      "docsfab: credential-like-content flagged for maintainers; DocsFab did not remove it: unscoped:field (credential.gitlab-token)\n",
    ]);
    expect(writes.join("")).not.toContain(GITLAB);
    // Nothing to record writes nothing.
    recordCredentialFindings([]);
    expect(writes).toHaveLength(1);
  });

  it("keeps collected findings in the shared order, without duplicates", () => {
    const findings = [
      { code: "credential-like-content" as const, location: "docs/b.md:2", rule: "credential.jwt" },
      {
        code: "credential-like-content" as const,
        location: "docs/a.md:9",
        rule: "credential.private-key",
      },
      { code: "credential-like-content" as const, location: "docs/b.md:2", rule: "credential.jwt" },
      {
        code: "credential-like-content" as const,
        location: "docs/a.md:9",
        rule: "credential.assigned-secret",
      },
      { code: "credential-like-content" as const, location: "Docs/a.md:1", rule: "credential.jwt" },
    ];
    const { findings: collected } = collectCredentialFindings(() =>
      recordCredentialFindings(findings),
    );
    expect(collected).toEqual(sortCredentialFindings(findings));
    expect(collected).toHaveLength(4);
    // Code-unit order, not locale order: a locale puts "_x" first and "a"
    // before "B"; code units put "B" (0x42) before "_" (0x5f) before "a".
    const drift = ["docs/a.md:1", "docs/_x.md:1", "docs/B.md:1"].map((location) => ({
      code: "credential-like-content" as const,
      location,
      rule: "credential.jwt",
    }));
    const ordered = collectCredentialFindings(() => recordCredentialFindings(drift)).findings;
    expect(ordered.map((finding) => finding.location)).toEqual([
      "docs/B.md:1",
      "docs/_x.md:1",
      "docs/a.md:1",
    ]);
    expect(ordered).toEqual(sortCredentialFindings(drift));
  });

  it("escapes a location a file name makes unsafe, so it cannot start a new stderr line", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    // A bidi override, a C1 control and a line separator, beside the line feeds
    // and tab: none of them may reach the log raw.
    const forged = ["docs/x\u202e", "docsfab: forged line\u009b", "/label ~x\ty\u2028.md:1"].join(
      "\n",
    );
    recordCredentialFindings([
      { code: "credential-like-content", location: forged, rule: "credential.jwt" },
      { code: "credential-like-content", location: "docs/a.md:3", rule: "credential.jwt" },
    ]);
    expect(writes).toEqual([
      'docsfab: credential-like-content flagged for maintainers; DocsFab did not remove it: docs/a.md:3 (credential.jwt), "docs/x\\u202e\\ndocsfab: forged line\\u009b\\n/label ~x\\ty\\u2028.md:1" ("credential.jwt")\n',
    ]);
    expect(writes[0]!.split("\n")).toHaveLength(2);
    expect(writes[0]).toMatch(/^[\x20-\x7e]*\n$/u);
    expect(
      isShowableCredentialFinding({
        code: "credential-like-content",
        location: forged,
        rule: "credential.jwt",
      }),
    ).toBe(false);
    for (const unsafe of [
      "docs/a`b.md:1",
      "docs/tab\t.md:1",
      "docs/bidi\u202e.md:1",
      "docs/sep\u2028.md:1",
      "docs/cr\r.md:1",
      "docs/Closes #1.md:3",
      "docs/no-break\u00a0space.md:1",
      "/etc/passwd:1",
      "docs/../secret.md:1",
    ]) {
      expect(
        isShowableCredentialFinding({
          code: "credential-like-content",
          location: unsafe,
          rule: "credential.jwt",
        }),
        unsafe,
      ).toBe(false);
    }
    expect(
      isShowableCredentialFinding({
        code: "credential-like-content",
        location: "docs/café.md:12",
        rule: "credential.jwt",
      }),
    ).toBe(true);
    expect(
      isShowableCredentialFinding({
        code: "credential-like-content",
        location: "docs/a.md:1",
        rule: "credential.jwt`",
      }),
    ).toBe(false);
  });

  it("returns DocsFab's own configured credential for the caller to refuse, and records no finding for it", () => {
    const planted = plantConfiguredCredential();
    expect(textShapeRuleIds(planted)).toEqual([]);
    const text = collectCredentialFindings(() =>
      screenCredentialText(`value ${planted} and ${GITLAB}`, "screen:text", textShapeRuleIds),
    );
    expect(text.result).toMatchObject({ form: "value" });
    expect(text.findings).toEqual([]);
    expect(JSON.stringify(text.result)).not.toContain(planted);
    const structured = collectCredentialFindings(() =>
      screenCredentialValue({ nested: [planted] }, "screen:value", (value) =>
        ruleIdsInValue(value, textShapeRuleIds),
      ),
    );
    expect(structured.result).toMatchObject({ form: "value" });
    // The same text without the configured value continues, flagged.
    const shaped = collectCredentialFindings(() =>
      screenCredentialValue({ nested: [GITLAB] }, "screen:value", (value) =>
        ruleIdsInValue(value, textShapeRuleIds),
      ),
    );
    expect(shaped).toEqual({
      result: null,
      findings: [
        {
          code: "credential-like-content",
          location: "screen:value",
          rule: "credential.gitlab-token",
        },
      ],
    });
  });
});
