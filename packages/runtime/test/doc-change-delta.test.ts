// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DOC_CHANGE_DELTA_KIND,
  assertDocChangeDeltaNonAuthority,
  createDocChangeDelta,
  createDocChangeDeltaProvenanceAuthority,
  decodeDocChangeDelta,
  validateDocChangeDelta,
  type DocChangeDeltaInputV1,
  type DocChangeDeltaV1,
  DocChangeDeltaError,
} from "../src/search/doc-change-delta.js";

const SHA = (digit: string) => digit.repeat(64);
const REVISION = "a".repeat(40);

function validInput(overrides: Partial<DocChangeDeltaInputV1> = {}): DocChangeDeltaInputV1 {
  return {
    repositoryIdentitySha256: SHA("1"),
    repositoryRevision: REVISION,
    repositoryContentDigestSha256: SHA("2"),
    sourceRunRecordSha256: SHA("3"),
    sourceLedgerSha256: SHA("4"),
    entries: [
      {
        section: "added",
        stableId: "search-finding:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        codes: ["gap.open", "requirement.missing"],
        labels: ["coverage-gap"],
        evidence: {
          observationSha256: SHA("5"),
          findingSha256: null,
          artifactRefSha256: null,
        },
        displayLifecycle: "open",
      },
      {
        section: "modified",
        stableId: "work-unit:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        codes: ["coverage.changed"],
        labels: [],
        evidence: {
          observationSha256: SHA("6"),
          findingSha256: SHA("7"),
          artifactRefSha256: null,
        },
        displayLifecycle: null,
      },
      {
        section: "removed",
        stableId: "search-finding:cccccccccccccccccccccccccccccccc",
        codes: ["disposition.obsolete"],
        labels: ["closed"],
        evidence: {
          observationSha256: null,
          findingSha256: null,
          artifactRefSha256: SHA("8"),
        },
        displayLifecycle: "verified",
      },
    ],
    trackerMutation: "not-authorized",
    ...overrides,
  };
}

describe("DocChangeDeltaV1 decoder", () => {
  it("accepts a valid sealed DocChangeDeltaV1", () => {
    const delta = createDocChangeDelta(validInput());
    expect(delta.kind).toBe(DOC_CHANGE_DELTA_KIND);
    expect(delta.schemaVersion).toBe(1);
    expect(delta.trackerMutation).toBe("not-authorized");
    expect(delta.entries).toHaveLength(3);
    expect(delta.entries.map((entry) => entry.section)).toEqual(["added", "modified", "removed"]);
    expect(decodeDocChangeDelta(delta)).toEqual(delta);
    expect(assertDocChangeDeltaNonAuthority(delta)).toBe("not-authorized");
  });

  it("rejects unknown fields", () => {
    const delta = createDocChangeDelta(validInput());
    expect(() => decodeDocChangeDelta({ ...delta, narration: "invented" })).toThrow(
      DocChangeDeltaError,
    );
    expect(() =>
      decodeDocChangeDelta({
        ...delta,
        entries: [
          {
            ...delta.entries[0],
            hostPath: "/tmp/secret",
          },
          ...delta.entries.slice(1),
        ],
      }),
    ).toThrow(DocChangeDeltaError);
  });

  it("rejects out-of-schema ids and labels as invalid values, not as host paths", () => {
    expect(() =>
      createDocChangeDelta(
        validInput({
          entries: [
            {
              section: "added",
              stableId: "/Users/example-user/Documents/docsfab/docs/foo.md",
              codes: ["gap.open"],
              labels: [],
              evidence: {
                observationSha256: SHA("5"),
                findingSha256: null,
                artifactRefSha256: null,
              },
              displayLifecycle: "open",
            },
          ],
        }),
      ),
    ).toThrowError(/invalid-value/);

    const delta = createDocChangeDelta(validInput());
    expect(() =>
      decodeDocChangeDelta({
        ...delta,
        entries: [
          {
            ...delta.entries[0],
            labels: ["/tmp/raw-match.txt"],
          },
          ...delta.entries.slice(1),
        ],
      }),
    ).toThrowError(/invalid-value/);
  });

  it("rejects missing evidence bindings", () => {
    expect(() =>
      createDocChangeDelta(
        validInput({
          entries: [
            {
              section: "added",
              stableId: "search-finding:dddddddddddddddddddddddddddddddd",
              codes: ["gap.open"],
              labels: [],
              evidence: {
                observationSha256: null,
                findingSha256: null,
                artifactRefSha256: null,
              },
              displayLifecycle: null,
            },
          ],
        }),
      ),
    ).toThrowError(/missing-evidence/);
  });

  it("rejects missing digests and wrong digest checksums", () => {
    const delta = createDocChangeDelta(validInput());
    expect(() =>
      decodeDocChangeDelta({
        ...delta,
        repositoryIdentitySha256: "not-a-digest",
      }),
    ).toThrow(DocChangeDeltaError);

    expect(() =>
      decodeDocChangeDelta({
        ...delta,
        deltaSha256: SHA("f"),
      }),
    ).toThrow(DocChangeDeltaError);

    const { repositoryContentDigestSha256: _removed, ...withoutContent } = delta;
    expect(() => decodeDocChangeDelta(withoutContent)).toThrow(DocChangeDeltaError);
  });

  it("rejects trackerMutation other than not-authorized", () => {
    const delta = createDocChangeDelta(validInput());
    expect(() =>
      decodeDocChangeDelta({
        ...delta,
        trackerMutation: "authorized",
      }),
    ).toThrow(DocChangeDeltaError);

    expect(() =>
      assertDocChangeDeltaNonAuthority({
        ...delta,
        trackerMutation: "apply",
      }),
    ).toThrow(DocChangeDeltaError);
  });

  it("requires host provenance admission beyond self-seal", () => {
    const delta = createDocChangeDelta(validInput());
    const lookalike = {
      kind: "docsfab-doc-change-delta-provenance-authority" as const,
    };
    expect(() =>
      validateDocChangeDelta({
        delta,
        provenance: lookalike,
      }),
    ).toThrowError(/authority-required/);

    const admitted = createDocChangeDeltaProvenanceAuthority({
      verifyCurrent(bindings) {
        expect(bindings.sourceRunRecordSha256).toBe(delta.sourceRunRecordSha256);
        expect(bindings.repositoryRevision).toBe(delta.repositoryRevision);
        return { status: "admitted" };
      },
    });
    const validated = validateDocChangeDelta({ delta, provenance: admitted });
    expect(validated).toEqual(delta);
  });

  it("keeps kind stable as docsfab-doc-change-delta", () => {
    const delta: DocChangeDeltaV1 = createDocChangeDelta(validInput());
    expect(delta.kind).toBe("docsfab-doc-change-delta");
    expect(DOC_CHANGE_DELTA_KIND).toBe("docsfab-doc-change-delta");
  });
});
