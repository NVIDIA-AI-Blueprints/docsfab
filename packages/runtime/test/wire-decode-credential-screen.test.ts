// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { containsAssignedCredential } from "../src/security/credential-material.js";
import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import { containsCredentialDeep, writePath } from "../src/host-invoker/wire-decode.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

/**
 * Behaviour of `wire-decode.ts`'s credential screen, which every hosted-runtime
 * field passes through (#1807): DocsFab's own configured credential refuses,
 * matched exactly, and a `DOCUMENT_CREDENTIAL_SHAPES` match is recorded as a
 * `credential-like-content` finding and admitted.
 *
 * Every probe carries a 10-character value: above the document list's `\S{8,}`
 * value floor and below the canonical detector's 12, so the canonical detector
 * (which this module never calls, but which guards the same text elsewhere)
 * cannot mask a narrowing of the list. The control assertions below state that
 * directly.
 */
const VALUE = "EXAMPLE".repeat(4).slice(0, 10);
const LONG_VALUE = "EXAMPLE".repeat(4);
const LOCATION = "hosted-test:field";
const ASSIGNED = {
  code: "credential-like-content",
  location: LOCATION,
  rule: "credential.assigned-secret",
};

/** The screen's verdict and the findings it recorded at LOCATION. */
function screen(value: unknown) {
  const { result, findings } = collectCredentialFindings(() =>
    containsCredentialDeep(value, LOCATION),
  );
  return { refused: result, findings };
}

describe("wire-decode credential screen", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("admits a quoted key and a CLI long flag and records each as a finding, never the value", () => {
    // Human-pasted JSON, canonicalJson's spacing, and a shell line as an
    // operator actually types it.
    for (const probe of [
      `"token": "${VALUE}"`,
      `{"token":"${VALUE}"}`,
      `glab api --private-token=${VALUE} projects/437040`,
    ]) {
      const { refused, findings } = screen(probe);
      expect(refused, probe).toBe(false);
      expect(findings, probe).toEqual([ASSIGNED]);
      expect(JSON.stringify(findings), probe).not.toContain(VALUE);
      // Isolation control: the canonical detector misses every one of these,
      // so the finding above is this list's doing and nothing else's.
      expect(containsAssignedCredential(probe), probe).toBe(false);
    }
  });

  it("records nothing without a location: the plain form is the exact configured match", () => {
    const { result, findings } = collectCredentialFindings(() =>
      containsCredentialDeep(`"token": "${VALUE}"`),
    );
    expect(result).toBe(false);
    expect(findings).toEqual([]);
  });

  it("walks into nested wire-packet values rather than only scanning the top-level string", () => {
    const nested = { request: { kind: "live-agent-turn", argv: [`--private-token=${VALUE}`] } };
    expect(screen(nested)).toEqual({ refused: false, findings: [ASSIGNED] });
    // The configured match walks the same structure.
    const planted = plantConfiguredCredential();
    expect(
      screen({ request: { kind: "live-agent-turn", argv: [`--label=${planted}`] } }).refused,
    ).toBe(true);
  });

  it("leaves shapes one step outside the two widened conditions unflagged", () => {
    // Adjacent conditions. `--` is handled; a single leading hyphen is
    // not. A closing quote on the keyword is handled; a plural or compound key
    // is not. Un-excluding `-` from the boundary class instead of adding a
    // `--` alternative flags the first three rows.
    for (const probe of [
      `non-token: ${LONG_VALUE}`,
      `non-secret: ${LONG_VALUE}`,
      `x-token: ${LONG_VALUE}`,
      `-private-token=${LONG_VALUE}`,
      `"tokens": "${LONG_VALUE}"`,
      `"auth-token-history": "${LONG_VALUE}"`,
      `token: ${LONG_VALUE.slice(0, 7)}`,
      // A credential-named field carrying a JSON subtree is structural, not an
      // assignment; the quoted branch requires a quoted value of the same
      // quote character on both sides.
      `"authorization":{"authorityId":"swap-operator","evidenceReference":"x"}`,
      `"token': "${LONG_VALUE}"`,
      "Status: pending",
      "error: boom",
    ]) {
      expect(screen(probe), probe).toEqual({ refused: false, findings: [] });
    }
  });

  it("flags an assignment whose value sits exactly on the value floor and not one character below it", () => {
    // The list's `\S{8,}` value floor, driven at the limit and at limit-1.
    // Unquoted form: a closing quote is a non-space character and joins the
    // run, so a quoted probe cannot sit exactly on the floor.
    expect(LONG_VALUE.slice(0, 8)).toHaveLength(8);
    expect(screen(`token=${LONG_VALUE.slice(0, 8)}`).findings).toEqual([ASSIGNED]);
    expect(screen(`token=${LONG_VALUE.slice(0, 7)}`).findings).toEqual([]);
    expect(screen(`--private-token=${LONG_VALUE.slice(0, 8)}`).findings).toEqual([ASSIGNED]);
    expect(screen(`--private-token=${LONG_VALUE.slice(0, 7)}`).findings).toEqual([]);
  });

  it("admits and records a write path carrying either widened shape, and refuses a configured credential", () => {
    // The shipped dispatch site: `writePath` screens before any path check, so
    // this is the guard a real decoded packet hits, not a helper.
    const path = `docs/--private-token=${VALUE}/page.md`;
    const { result, findings } = collectCredentialFindings(() => writePath(path, false));
    expect(result).toBe(path);
    expect(findings).toEqual([
      {
        code: "credential-like-content",
        location: "hosted-write-path",
        rule: "credential.assigned-secret",
      },
    ]);
    const planted = plantConfiguredCredential();
    expect(() => writePath(`docs/${planted}/page.md`, false)).toThrow(/credential-material/u);
  });

  it("still accepts an ordinary write path and records nothing", () => {
    const { result, findings } = collectCredentialFindings(() =>
      writePath("docs/guides/getting-started.md", false),
    );
    expect(result).toBe("docs/guides/getting-started.md");
    expect(findings).toEqual([]);
  });
});
