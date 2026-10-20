// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which tracked paths the original source authority admits as members, and
 * the coded stop for a path it still refuses.
 *
 * The authority compares, sorts, and digests member paths as exact strings, so
 * it admits every character Git allows except the ones that break path
 * identity, containment, or safe display. A refused path stops with
 * `source-authority-path-refused`, naming the path and the rule.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import {
  DEFAULT_DOCS_ANCHORS,
  DEFAULT_NEXT_ACTIONS,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import {
  SECURITY_RULE_IDS,
  detectCredentialRuleIdsInValue,
} from "../src/security/repository-scanner.js";
import {
  INVALID_ORIGINAL_SOURCE_AUTHORITY,
  INVALID_ORIGINAL_SOURCE_AUTHORITY_NEXT_ACTION,
  OriginalSourceAuthorityError,
  SOURCE_AUTHORITY_PATH_REFUSED,
  SOURCE_AUTHORITY_PATH_REFUSED_NEXT_ACTION,
  originalSourceAuthorityMemberMap,
  sealOriginalSourceAuthority,
  validateOriginalSourceAuthorityEvidence,
  type OriginalSourceAuthorityMemberV1,
} from "../src/workflow-execution/source-obligation-authority.js";
import { normalizeRepositoryLocator } from "../src/workflow-execution/review-response.js";
import { configureCredential } from "./helpers/configured-credential.js";

const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);
const MAX_CHARS = LIMIT_DEFINITION_BY_NAME["sources.authorityMemberPathMaxChars"]!;
const TECHNICAL_RESPONSE_TROUBLESHOOTING = "docs/troubleshooting.md";

function member(path: string): OriginalSourceAuthorityMemberV1 {
  const contents = `${path}\n`;
  return {
    path,
    mode: 0o644,
    byteLength: Buffer.byteLength(contents),
    sourceSha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function seal(paths: readonly string[]) {
  return sealOriginalSourceAuthority({
    runId: "authority-paths-run",
    scope: "review-tracked-workspace",
    repositoryRevision: REVISION,
    scopeSha256: DIGEST,
    workspaceSnapshotSha256: DIGEST,
    members: [...paths].sort().map(member),
  });
}

function refusal(path: string): OriginalSourceAuthorityError {
  try {
    seal([path]);
  } catch (error) {
    expect(error).toBeInstanceOf(OriginalSourceAuthorityError);
    return error as OriginalSourceAuthorityError;
  }
  throw new Error(`Expected the authority to refuse ${JSON.stringify(path)}, but it sealed.`);
}

function expectAdmitted(path: string): void {
  const sealed = seal([path]);
  const validated = validateOriginalSourceAuthorityEvidence(sealed.evidence);
  expect(validated.members.map((entry) => entry.path)).toEqual([path]);
  expect(originalSourceAuthorityMemberMap(validated).get(path)).toEqual(member(path));
}

describe("member paths the original source authority admits", () => {
  it.each([
    ["+", "docs/c++/guide.md"],
    ["@", "assets/logo@2x.png"],
    ["@ at the start", "@scope/pkg/README.md"],
    ["@ before a compound extension", "cli/tests/cli-reference@.md.snap"],
    ["!", "docs/Read me first!.md"],
    [",", "docs/Install, configure, and run.md"],
    ["=", "data/year=2026/notes.md"],
    ["~ inside a segment", "docs/backup~1.md"],
    ["~ at the start of a later segment", "docs/~draft.md"],
    ["- at the start of a later segment", "docs/-draft.md"],
    ["#", "samples/c#/intro.md"],
    ["%", "docs/100% coverage.md"],
    ["'", "docs/Don't panic.md"],
    ["parentheses", "assets/image (1).png"],
    ["brackets", "pages/[slug].md"],
    ["&", "docs/Q&A.md"],
    ["non-ASCII letters", "docs/ja/はじめに.md"],
    ["an accented letter in NFC", "docs/caf\u00e9.md"],
    ["a brace placeholder segment at the start", "{name}/page.py"],
  ])("admits %s, as in %s", (_label, path) => {
    expectAdmitted(path);
  });

  it("admits every printable ASCII character except / \\ : and braces inside a segment", () => {
    const admitted: string[] = [];
    for (let code = 0x20; code < 0x7f; code += 1) {
      const character = String.fromCharCode(code);
      if ("/\\:{}".includes(character)) continue;
      const path = `docs/a${character}b.md`;
      expectAdmitted(path);
      admitted.push(character);
    }
    expect(admitted).toHaveLength(95 - 5);
  });

  it("admits a path at the length limit and refuses one character over it with the limit's code", () => {
    const atLimit = `docs/${"a".repeat(MAX_CHARS.value - "docs/".length)}`;
    expect(atLimit).toHaveLength(MAX_CHARS.value);
    expectAdmitted(atLimit);

    const overLimit = `${atLimit}b`;
    const error = refusal(overLimit);
    expect(error.code).toBe(MAX_CHARS.refusal);
    expect(error.message).toContain(`Tracked path "${overLimit}"`);
    expect(error.message).toContain(
      `${MAX_CHARS.refusal}: ${MAX_CHARS.value + 1} exceeds sources.authorityMemberPathMaxChars = ${MAX_CHARS.value} characters.`,
    );
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "bound",
      layer: "workflow",
      code: MAX_CHARS.refusal,
    });
    expect(MAX_CHARS.scope).toBe("sealed");
  });

  it("admits citation-shaped file names as their own members without binding a citation to them", () => {
    const literal = "src/api.ts#section";
    const sealed = seal(["src/api.ts", literal, "src/api.ts, evidence"]);
    const members = originalSourceAuthorityMemberMap(sealed.evidence);
    // The locator grammar still reads the literal name as a citation of src/api.ts,
    // and a citation resolves only to that file's member.
    expect(normalizeRepositoryLocator(literal).path).toBe("src/api.ts");
    expect(members.get(normalizeRepositoryLocator(literal).path!)).toEqual(member("src/api.ts"));
    expect(members.get(literal)).toEqual(member(literal));
  });
});

describe("member paths the original source authority refuses", () => {
  it.each([
    ["a tab", "src/with\ttab.ts", "it contains a control, format, or line-separator character"],
    ["a newline", "src/with\nnewline.ts", "control, format, or line-separator"],
    ["NUL", "src/with\0null.ts", "control, format, or line-separator"],
    ["DEL", "src/with\x7fdelete.ts", "control, format, or line-separator"],
    ["a C1 control", "src/with\u009bcsi.ts", "control, format, or line-separator"],
    ["a bidirectional override", "src/evil\u202etxt.md", "control, format, or line-separator"],
    ["a zero-width space", "src/zero\u200bwidth.md", "control, format, or line-separator"],
    ["a line separator", "src/line\u2028sep.md", "control, format, or line-separator"],
    ["a lone surrogate", "src/half\ud800.md", "control, format, or line-separator"],
    ["a private-use code point", "src/private\ue000.md", "control, format, or line-separator"],
    ["a backslash", "src\\api.ts", "it contains a backslash"],
    ["a colon", "src/api.ts:1", "it contains a colon"],
    ["a drive letter", "C:/api.ts", "it contains a colon"],
    ["a URL", "https://example.test/api.ts", "it contains a colon"],
    ["an absolute path", "/absolute.ts", "it is absolute"],
    ["a leading ~", "~/api.ts", "it starts with ~"],
    ["a leading -", "-rf.md", "it starts with -"],
    ["an empty path", "", "it is empty"],
    ["an empty segment", "src//api.ts", "it has an empty segment"],
    ["a trailing slash", "src/", "it has an empty segment"],
    ["a . segment", "src/./api.ts", "it has a . or .. segment"],
    ["a .. segment", "src/../api.ts", "it has a . or .. segment"],
    ["a leading space", " src/api.ts", "a segment starts or ends with whitespace"],
    ["a trailing space", "src/api.ts ", "a segment starts or ends with whitespace"],
    ["a leading no-break space", "src/\u00a0api.ts", "a segment starts or ends with whitespace"],
    [
      "a partial brace",
      "src/pre{name}post.ts",
      "it uses { or } outside a whole-segment {name} placeholder",
    ],
    ["nested braces", "src/{{name}}.ts", "outside a whole-segment {name} placeholder"],
    ["a decomposed accent", "docs/cafe\u0301.md", "it is not in Unicode normalization form C"],
  ])("refuses %s with a coded stop naming the path and the rule", (_label, path, rule) => {
    const error = refusal(path);
    expect(error.code).toBe(SOURCE_AUTHORITY_PATH_REFUSED);
    expect(error.message).toMatch(
      /^Tracked path ".*" cannot enter the original source authority: /u,
    );
    expect(error.message).toContain(rule);
    expect(error.message).toContain(
      "Rename it or stop tracking it, commit the change, and rerun the same command.",
    );
    expect(error.nextAction).toBe(SOURCE_AUTHORITY_PATH_REFUSED_NEXT_ACTION);
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "operator-input",
      layer: "workflow",
      code: SOURCE_AUTHORITY_PATH_REFUSED,
    });
  });

  it("names the path with unsafe code points escaped, so the message carries no raw control", () => {
    const message = refusal("docs/evil\u202etxt.md\u009b").message;
    expect(message).toContain('Tracked path "docs/evil\\u{202e}txt.md\\u{9b}"');
    expect(message).not.toMatch(/[\u202e\u009b]/u);
    expect(refusal('docs/say "hi"\\x.md').message).toContain(
      'Tracked path "docs/say \\"hi\\"\\\\x.md"',
    );
  });

  it("seals a credential-shaped path, and refuses a configured credential without naming it", () => {
    // The body is derived at run time, so no key-shaped literal sits in the source for a secret
    // scanner to find; the same digest gives the same key on every run.
    const body = createHash("sha256").update("planted-path").digest("base64url");
    const key = `nvapi-${body}`;
    // The detector reads the planted value as an nvapi- credential; that shape
    // alone names a member (#1807), and only the configured copy is refused.
    expect(detectCredentialRuleIdsInValue(key)).toContain(SECURITY_RULE_IDS.nvidiaApiKey);
    expect(() => seal([`docs/${key}.md`])).not.toThrow();
    configureCredential(key);
    const error = refusal(`docs/${key}.md`);
    expect(error.code).toBe(SOURCE_AUTHORITY_PATH_REFUSED);
    expect(error.message).toContain('Tracked path "docs/[REDACTED].md"');
    expect(error.message).toContain("it holds a configured credential");
    expect(error.message).not.toContain(key);
  });

  it("names the broken rule for evidence that breaks the authority's own contract", () => {
    const sealed = seal(["docs/a.md", "docs/b.md"]);
    const reordered = structuredClone(sealed.evidence);
    (reordered.members as OriginalSourceAuthorityMemberV1[]).reverse();
    let thrown: unknown;
    try {
      validateOriginalSourceAuthorityEvidence(reordered);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OriginalSourceAuthorityError);
    const error = thrown as OriginalSourceAuthorityError;
    expect(error.code).toBe(INVALID_ORIGINAL_SOURCE_AUTHORITY);
    expect(error.message).toBe(
      "Original source authority evidence did not satisfy the host-owned contract: member-order.",
    );
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: INVALID_ORIGINAL_SOURCE_AUTHORITY,
    });
    expect(() =>
      validateOriginalSourceAuthorityEvidence({ ...sealed.evidence, digest: DIGEST }),
    ).toThrow("did not satisfy the host-owned contract: evidence-digest.");
    // A closed-schema check names its rule too.
    expect(() =>
      validateOriginalSourceAuthorityEvidence({ ...sealed.evidence, extra: true }),
    ).toThrow("did not satisfy the host-owned contract: shape.");
  });

  it("keeps each catalog next action equal to the error's, with the path stop's docs anchor", () => {
    expect(DEFAULT_NEXT_ACTIONS[SOURCE_AUTHORITY_PATH_REFUSED]).toBe(
      SOURCE_AUTHORITY_PATH_REFUSED_NEXT_ACTION,
    );
    expect(DEFAULT_NEXT_ACTIONS[INVALID_ORIGINAL_SOURCE_AUTHORITY]).toBe(
      INVALID_ORIGINAL_SOURCE_AUTHORITY_NEXT_ACTION,
    );
    expect(DEFAULT_DOCS_ANCHORS[SOURCE_AUTHORITY_PATH_REFUSED]).toBe(
      TECHNICAL_RESPONSE_TROUBLESHOOTING,
    );
    // A path whose words match a remediation keyword keeps the catalog action.
    const envelope = toOperatorErrorEnvelope(refusal("docs/profile/doctor:config.md"));
    expect(envelope).toMatchObject({
      code: SOURCE_AUTHORITY_PATH_REFUSED,
      nextAction: SOURCE_AUTHORITY_PATH_REFUSED_NEXT_ACTION,
      docsAnchor: TECHNICAL_RESPONSE_TROUBLESHOOTING,
      failure: { class: "operator-input", layer: "cli", code: SOURCE_AUTHORITY_PATH_REFUSED },
    });
  });
});
