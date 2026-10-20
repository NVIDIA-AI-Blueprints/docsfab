// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import {
  CREDENTIAL_FINDING_LOCATION_LIMIT,
  CREDENTIAL_LIKE_CONTENT,
  type CredentialFinding,
  credentialFindingLocation,
  formatCredentialFindingNotes,
  sortCredentialFindings,
} from "../src/security/credential-findings.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

function finding(location: string, rule: string): CredentialFinding {
  return { code: CREDENTIAL_LIKE_CONTENT, location, rule };
}

describe("credential findings", () => {
  it("sorts by location, then rule, and removes duplicates", () => {
    expect(
      sortCredentialFindings([
        finding("docs/b.md:3", "credential.assigned-secret"),
        finding("docs/a.md:12", "credential.gitlab-token"),
        finding("docs/a.md:12", "credential.assigned-secret"),
        finding("docs/b.md:3", "credential.assigned-secret"),
        finding("request:instruction", "credential.assigned-secret"),
      ]),
    ).toEqual([
      finding("docs/a.md:12", "credential.assigned-secret"),
      finding("docs/a.md:12", "credential.gitlab-token"),
      finding("docs/b.md:3", "credential.assigned-secret"),
      finding("request:instruction", "credential.assigned-secret"),
    ]);
  });

  it("writes a location every record reader admits, whatever the path (#1807)", () => {
    const bound = limit(CREDENTIAL_FINDING_LOCATION_LIMIT).value;
    expect(credentialFindingLocation("docs/page.md", 7)).toBe("docs/page.md:7");
    expect(credentialFindingLocation("docs/page.md")).toBe("docs/page.md");
    // Control characters are written out, never kept.
    expect(credentialFindingLocation("docs/tab\tand\u0001bell\nline.md", 2)).toBe(
      "docs/tab\\u0009and\\u0001bell\\u000aline.md:2",
    );
    // A long path keeps its line and is cut at a visible marker whose digest
    // keeps two long paths apart.
    const long = (leaf: string) => `docs/${"deep/".repeat(300)}${leaf}`;
    const first = credentialFindingLocation(long("a.md"), 12);
    const second = credentialFindingLocation(long("b.md"), 12);
    for (const location of [first, second]) {
      expect(location.length).toBeLessThanOrEqual(bound);
      expect(location).toMatch(/…\[cut; sha256 [0-9a-f]{16}\]:12$/u);
      expect(location.startsWith("docs/deep/deep/")).toBe(true);
    }
    expect(first).not.toBe(second);
    const atBound = `docs/${"x".repeat(bound - "docs/".length - 2)}`;
    expect(credentialFindingLocation(atBound, 9)).toBe(`${atBound}:9`);
    expect(credentialFindingLocation(`${atBound}y`, 9)).toMatch(
      /…\[cut; sha256 [0-9a-f]{16}\]:9$/u,
    );
    // DocsFab's own configured credential never reaches a record, even in a path.
    const credential = configureCredential(["harbor", plantedCredentialValue(90, 24)].join("-"));
    const redacted = credentialFindingLocation(`docs/${credential}/notes.md`, 3);
    expect(redacted).toBe("docs/[REDACTED]/notes.md:3");
  });

  it("formats one notes line, and nothing without findings", () => {
    expect(formatCredentialFindingNotes([], 10)).toBeUndefined();
    expect(
      formatCredentialFindingNotes(
        [
          finding("docs/b.md:3", "credential.assigned-secret"),
          finding("docs/a.md:12", "credential.assigned-secret"),
        ],
        10,
      ),
    ).toBe(
      "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `docs/a.md:12` (`credential.assigned-secret`), `docs/b.md:3` (`credential.assigned-secret`)",
    );
  });

  it("names at most the listed number and counts the rest", () => {
    const findings = [
      finding("docs/c.md:1", "credential.assigned-secret"),
      finding("docs/a.md:1", "credential.assigned-secret"),
      finding("docs/b.md:1", "credential.assigned-secret"),
    ];
    expect(formatCredentialFindingNotes(findings, 2)).toBe(
      "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** `docs/a.md:1` (`credential.assigned-secret`), `docs/b.md:1` (`credential.assigned-secret`), and 1 more",
    );
    expect(formatCredentialFindingNotes(findings, 3)).not.toContain("more");
    expect(formatCredentialFindingNotes(findings, 0)).toBe(
      "- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** and 3 more",
    );
  });
});
