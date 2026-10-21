// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeSourceRequestSha256,
  computeSourceRequestSha256V2,
  computeSourceRequestSha256V3,
  computeSourceRequestSha256V4,
  projectSourceRequestContext,
  selectSourceRequestProjectionVersion,
  SOURCE_REQUEST_FIELD_CLASSES,
  SOURCE_REQUEST_PENDING_CONTINUATION_FIELDS,
  SOURCE_REQUEST_PROJECTED_FIELDS,
  SOURCE_REQUEST_PROJECTED_FIELDS_V2,
  SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS,
  SOURCE_REQUEST_PROJECTED_FIELDS_V3,
  SOURCE_REQUEST_PROJECTED_FIELDS_V3_ADDITIONS,
  SOURCE_REQUEST_PROJECTED_FIELDS_V4,
  SOURCE_REQUEST_PROJECTED_FIELDS_V4_ADDITIONS,
  SOURCE_REQUEST_PROJECTED_FIELDS_V5,
  SOURCE_REQUEST_PROJECTED_FIELDS_V5_ADDITIONS,
  SOURCE_REQUEST_PROJECTION_VERSIONS,
  SOURCE_REQUEST_RESOLVED_FIELDS,
  SourceEvidenceContractError,
  type SourceRequestContextV1,
  type SourceRequestContextV2,
  type SourceRequestContextV3,
  type SourceRequestContextV4,
} from "../src/inputs/index.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const RUN_ID = "run-798a-projection";
const REPOSITORY_IDENTITY = sha("repository-identity");
const REVISION = "a".repeat(40);
const WORKSPACE_IDENTITY = sha("workspace-identity");
const OTHER_WORKSPACE_IDENTITY = sha("other-workspace-identity");

const RESOLVED = {
  runId: RUN_ID,
  workspaceIdentitySha256: WORKSPACE_IDENTITY,
  repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
};

/**
 * The canonical no-source CREATE request. Its version-1 digest is pinned below,
 * so a future projection edit cannot silently re-hash a historical binding.
 */
const CREATE_REQUEST = {
  workflow: "create-documentation",
  workspacePath: "/workspace/docsfab",
  repository: { sourcePath: "/repo", revision: REVISION },
  allowWrite: false,
  instruction: "Document the release notes page.",
};

/** The version-1 compatibility digest of `CREATE_REQUEST`. It must not move. */
const VERSION_1_GOLDEN_SHA256 = "f1d607e7e1a9994a8628b5e04a6a26af2a1926eed6cfe7e495cd82715cdf3e6c";

/**
 * The same canonical request pinned to version 2, so the version-2 body — its
 * `projectionVersion` discriminant and its five explicit nulls — cannot be
 * edited silently either.
 */
const VERSION_2_GOLDEN_SHA256 = "1e54b061f91764a620ba1fc5511684e9aeed51f62949f9e54780405e0ec458cc";

/**
 * The whole update-documentation fixture below, pinned at version 2. Unlike a
 * symmetric "these two digests differ" assertion, a literal pin is asymmetric:
 * it fails when any of the five fields is read into another field's slot, which
 * a swap between two divergent values cannot show on its own.
 */
const UPDATE_REQUEST_V2_GOLDEN_SHA256 =
  "b340e52f76b3775f7d389a3f69d618b77c3197497dd3aaf941680a170eb53ab3";

/**
 * Divergent update fixtures. Every identifier, digest and sentence differs
 * between `READER_INPUT_A` and `READER_INPUT_B` in exactly one nested field, so
 * an identity collision cannot fake a digest-sensitivity pass.
 */
const READER_INPUT_A = {
  reader_job: "Learn which flag admits a source on an update run.",
  reader_context: { known: ["the runner quickstart"], unknown: ["the source flag"] },
};
const READER_INPUT_B = {
  reader_job: "Learn which flag admits a source on an update run.",
  reader_context: { known: ["the runner quickstart"], unknown: ["the citation ledger"] },
};
const READER_TASK_CONTEXT = {
  readerContextInput: READER_INPUT_A,
  admissionSha256: sha("reader-task-context-admission"),
};
const READER_CONTEXT = { audience: "runtime operator", snapshotSha256: sha("reader-context") };
const READER_CONTEXT_PROVENANCE = { supplierId: "host-reader-supplier", observedAt: "2026-09-16" };
const EDITORIAL_EVIDENCE_REFS = [
  { kind: "editorial-evidence", id: "artifact-one", digestSha256: sha("artifact-one") },
  { kind: "editorial-evidence", id: "artifact-two", digestSha256: sha("artifact-two") },
];

/** An UPDATE request carrying all five fields version 1 cannot represent. */
const UPDATE_REQUEST = {
  workflow: "update-documentation",
  workspacePath: "/workspace/docsfab",
  repository: { sourcePath: "/repo", revision: REVISION },
  allowWrite: true,
  instruction: "Update the runner quickstart for the source flag.",
  readerContextInput: READER_INPUT_A,
  readerTaskContext: READER_TASK_CONTEXT,
  readerContext: READER_CONTEXT,
  readerContextProvenance: READER_CONTEXT_PROVENANCE,
  editorialEvidenceRefs: EDITORIAL_EVIDENCE_REFS,
};

function project(
  request: Record<string, unknown>,
  options?: { readonly projectionVersion?: number },
): string {
  return projectSourceRequestContext({ ...request }, RESOLVED, options);
}

function expectContractCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected a source-evidence contract rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceEvidenceContractError);
    expect((error as SourceEvidenceContractError).code).toBe(code);
  }
}

const VERSION_1_CONTEXT: SourceRequestContextV1 = {
  runId: RUN_ID,
  workflow: CREATE_REQUEST.workflow,
  repository: RESOLVED.repository,
  workspaceIdentitySha256: WORKSPACE_IDENTITY,
  task: null,
  contextTarget: null,
  instruction: CREATE_REQUEST.instruction,
  reviewScope: null,
  allowWrite: false,
  releaseDefaultBranch: null,
  taskLineage: null,
  compositionExecution: null,
  knowledgeResumeReceipt: null,
};

const VERSION_2_CONTEXT: SourceRequestContextV2 = {
  ...VERSION_1_CONTEXT,
  readerContextInput: null,
  readerTaskContext: null,
  readerContext: null,
  readerContextProvenance: null,
  editorialEvidenceRefs: null,
};

describe("source request projection versioning (#798)", () => {
  it("refuses an update-documentation request carrying readerContextInput when the version-1 projection is pinned", () => {
    // The exact shipped refusal, not a truthy throw: version 1 has no way to
    // represent the field, and dropping it from evidence is never an option.
    expectContractCode(
      () =>
        project(
          {
            ...CREATE_REQUEST,
            workflow: "update-documentation",
            readerContextInput: READER_INPUT_A,
          },
          { projectionVersion: 1 },
        ),
      "projection-unversioned",
    );
    // Positive control: the same request minus readerContextInput projects.
    expect(
      project({ ...CREATE_REQUEST, workflow: "update-documentation" }, { projectionVersion: 1 }),
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses each of the five update fields individually under a pinned version-1 projection", () => {
    for (const [field, value] of [
      ["readerContextInput", READER_INPUT_A],
      ["readerTaskContext", READER_TASK_CONTEXT],
      ["readerContext", READER_CONTEXT],
      ["readerContextProvenance", READER_CONTEXT_PROVENANCE],
      ["editorialEvidenceRefs", EDITORIAL_EVIDENCE_REFS],
    ] as const) {
      expectContractCode(
        () => project({ ...CREATE_REQUEST, [field]: value }, { projectionVersion: 1 }),
        "projection-unversioned",
      );
      // Positive control: version 2 represents the same field.
      expect(project({ ...CREATE_REQUEST, [field]: value }, { projectionVersion: 2 })).toMatch(
        /^[0-9a-f]{64}$/u,
      );
    }
  });

  it("represents a whole update-documentation request under the version-2 projection", () => {
    const digest = project(UPDATE_REQUEST);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).toBe(project(UPDATE_REQUEST, { projectionVersion: 2 }));
  });

  it("projects readerContextInput, readerTaskContext, readerContext, readerContextProvenance and editorialEvidenceRefs as explicit null when absent", () => {
    // A bare request pinned to version 2 must equal the normalized context in
    // which all five are explicit null. If any field is dropped from
    // computeSourceRequestSha256V2's key list, `exact` rejects this context.
    expect(project(CREATE_REQUEST, { projectionVersion: 2 })).toBe(
      computeSourceRequestSha256V2(VERSION_2_CONTEXT),
    );
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V2).toEqual([
      ...SOURCE_REQUEST_PROJECTED_FIELDS,
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS,
    ]);
  });

  it("moves the version-2 digest for a change in any one of the five added fields", () => {
    const base = project(UPDATE_REQUEST);
    const moved = [
      { ...UPDATE_REQUEST, readerContextInput: READER_INPUT_B },
      {
        ...UPDATE_REQUEST,
        readerTaskContext: { ...READER_TASK_CONTEXT, readerContextInput: READER_INPUT_B },
      },
      { ...UPDATE_REQUEST, readerContext: { ...READER_CONTEXT, audience: "documentation reader" } },
      {
        ...UPDATE_REQUEST,
        readerContextProvenance: { ...READER_CONTEXT_PROVENANCE, observedAt: "2026-09-15" },
      },
      { ...UPDATE_REQUEST, editorialEvidenceRefs: [EDITORIAL_EVIDENCE_REFS[0]!] },
    ].map((request) => project(request));
    for (const digest of moved) expect(digest).not.toBe(base);
    expect(new Set(moved).size).toBe(moved.length);
  });

  it("changes the request digest when readerContextInput changes and leaves it unchanged when only the workspace path changes", () => {
    // READER_INPUT_A and READER_INPUT_B differ in exactly one nested field.
    expect(project({ ...UPDATE_REQUEST, readerContextInput: READER_INPUT_B })).not.toBe(
      project(UPDATE_REQUEST),
    );
    // Two distinct workspace paths map to the same authenticated identity.
    expect(project({ ...UPDATE_REQUEST, workspacePath: "/elsewhere/docsfab" })).toBe(
      project(UPDATE_REQUEST),
    );
  });

  it("binds the authenticated workspace identity rather than the path under version 2", () => {
    expect(
      projectSourceRequestContext(
        { ...UPDATE_REQUEST },
        {
          ...RESOLVED,
          workspaceIdentitySha256: OTHER_WORKSPACE_IDENTITY,
        },
      ),
    ).not.toBe(project(UPDATE_REQUEST));
  });

  it("distinguishes readerContext from readerContextProvenance in the version-2 digest", () => {
    // Two divergent values swapped between the two fields must move the digest.
    const swapped = {
      ...UPDATE_REQUEST,
      readerContext: READER_CONTEXT_PROVENANCE,
      readerContextProvenance: READER_CONTEXT,
    };
    expect(project(swapped)).not.toBe(project(UPDATE_REQUEST));
    // A swap is symmetric, so the inequality above survives a projection that
    // reads each field into the other's slot. The pin below does not.
    expect(project(UPDATE_REQUEST)).toBe(UPDATE_REQUEST_V2_GOLDEN_SHA256);
  });

  it("pins the version-2 digest of a whole update-documentation request", () => {
    // The identity anchor for version 2: every one of the five added slots,
    // the shared version-1 body, and the version discriminant are covered.
    expect(project(UPDATE_REQUEST)).toBe(UPDATE_REQUEST_V2_GOLDEN_SHA256);
    expect(project(UPDATE_REQUEST, { projectionVersion: 2 })).toBe(UPDATE_REQUEST_V2_GOLDEN_SHA256);
    expect(
      computeSourceRequestSha256V2({
        ...VERSION_1_CONTEXT,
        workflow: UPDATE_REQUEST.workflow,
        instruction: UPDATE_REQUEST.instruction,
        allowWrite: true,
        readerContextInput: READER_INPUT_A,
        readerTaskContext: READER_TASK_CONTEXT,
        readerContext: READER_CONTEXT,
        readerContextProvenance: READER_CONTEXT_PROVENANCE,
        editorialEvidenceRefs: EDITORIAL_EVIDENCE_REFS,
      }),
    ).toBe(UPDATE_REQUEST_V2_GOLDEN_SHA256);
  });

  it("keeps editorialEvidenceRefs order load-bearing in the version-2 digest", () => {
    const reversed = {
      ...UPDATE_REQUEST,
      editorialEvidenceRefs: [...EDITORIAL_EVIDENCE_REFS].reverse(),
    };
    expect(project(reversed)).not.toBe(project(UPDATE_REQUEST));
  });

  it("keeps the version-1 digest byte-identical for a request with none of the five new fields", () => {
    // The compatibility anchor: the version-1 digest of the canonical
    // no-source CREATE request.
    expect(project(CREATE_REQUEST)).toBe(VERSION_1_GOLDEN_SHA256);
    expect(project(CREATE_REQUEST, { projectionVersion: 1 })).toBe(VERSION_1_GOLDEN_SHA256);
    expect(computeSourceRequestSha256(VERSION_1_CONTEXT)).toBe(VERSION_1_GOLDEN_SHA256);
  });

  it("never reduces a version-2 request to the version-1 digest of the same request", () => {
    // The version-2 body carries projectionVersion: 2 plus the five fields, so
    // collapsing version 2 into version 1 cannot go unnoticed.
    expect(project(CREATE_REQUEST, { projectionVersion: 2 })).not.toBe(VERSION_1_GOLDEN_SHA256);
    expect(computeSourceRequestSha256V2(VERSION_2_CONTEXT)).not.toBe(
      computeSourceRequestSha256(VERSION_1_CONTEXT),
    );
    // Pinning the version-2 body makes every part of it load-bearing,
    // including the discriminant that a collision argument alone would not.
    expect(project(CREATE_REQUEST, { projectionVersion: 2 })).toBe(VERSION_2_GOLDEN_SHA256);
    expect(computeSourceRequestSha256V2(VERSION_2_CONTEXT)).toBe(VERSION_2_GOLDEN_SHA256);
  });

  it("selects the lowest projection version that represents the request", () => {
    expect(SOURCE_REQUEST_PROJECTION_VERSIONS).toEqual([1, 2, 3, 4, 5]);
    expect(selectSourceRequestProjectionVersion({ ...CREATE_REQUEST })).toBe(1);
    for (const field of SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS) {
      expect(selectSourceRequestProjectionVersion({ ...CREATE_REQUEST, [field]: null })).toBe(2);
    }
    // Producer and verifier reach the same version from the same object.
    expect(selectSourceRequestProjectionVersion({ ...UPDATE_REQUEST })).toBe(2);
    expect(project(UPDATE_REQUEST)).toBe(project(UPDATE_REQUEST, { projectionVersion: 2 }));
  });

  it("refuses an unrecognized projection version instead of minting one", () => {
    for (const version of [0, 6, 1.5, -1, Number.NaN]) {
      expectContractCode(
        () => project(CREATE_REQUEST, { projectionVersion: version }),
        "projection-unversioned",
      );
    }
    // Positive control: every recognized version projects.
    for (const version of SOURCE_REQUEST_PROJECTION_VERSIONS.filter((value) => value < 5)) {
      expect(project(CREATE_REQUEST, { projectionVersion: version })).toMatch(/^[0-9a-f]{64}$/u);
    }
    // V5 is recognized but requires a sealed host-projected PR basis.
    expectContractCode(() => project(CREATE_REQUEST, { projectionVersion: 5 }), "invalid-shape");
  });

  it("still refuses an unknown field with projection-unversioned after the new fields are recognized", () => {
    expectContractCode(
      () => project({ ...UPDATE_REQUEST, someFutureAdmissionField: "value" }),
      "projection-unversioned",
    );
    expectContractCode(
      () =>
        project({ ...UPDATE_REQUEST, someFutureAdmissionField: "value" }, { projectionVersion: 2 }),
      "projection-unversioned",
    );
    // Positive control: the same request without the unknown field projects.
    expect(project(UPDATE_REQUEST)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("still refuses a knowledgeContinuation field with continuation-projection-pending, not projection-unversioned", () => {
    for (const field of [
      "knowledgeContinuationReceipt",
      "knowledgeContinuationRecoveryAuthorization",
      "knowledgeContinuationSnapshotSha256",
      "knowledgeContinuationAcceptanceSha256",
    ]) {
      // The dedicated code must win at every version, and the ordering that
      // gives it priority over the unknown-field code must not drift.
      expectContractCode(
        () => project({ ...UPDATE_REQUEST, [field]: sha("continuation") }),
        "continuation-projection-pending",
      );
      expectContractCode(
        () =>
          project({ ...CREATE_REQUEST, [field]: sha("continuation") }, { projectionVersion: 1 }),
        "continuation-projection-pending",
      );
      expectContractCode(
        () =>
          project({ ...CREATE_REQUEST, [field]: sha("continuation") }, { projectionVersion: 2 }),
        "continuation-projection-pending",
      );
    }
    // Positive control: the projected resume-receipt sibling still projects.
    expect(project({ ...UPDATE_REQUEST, knowledgeResumeReceipt: { id: "resume-1" } })).not.toBe(
      project(UPDATE_REQUEST),
    );
  });

  it("refuses a sourceBinding, signal or workspacePath inside the projected body", () => {
    for (const field of ["sourceBinding", "signal", "workspacePath"]) {
      expectContractCode(
        () =>
          computeSourceRequestSha256V2({
            ...VERSION_2_CONTEXT,
            [field]: "value",
          } as unknown as SourceRequestContextV2),
        "invalid-shape",
      );
    }
    // Positive control: the same three stay legal on the request and leave the
    // version-2 digest untouched, because the projection excludes them.
    const base = project(UPDATE_REQUEST);
    expect(
      project({
        ...UPDATE_REQUEST,
        sourceBinding: { kind: "source-binding", digestSha256: sha("binding") },
        workspacePath: "/elsewhere/docsfab",
        signal: undefined,
      }),
    ).toBe(base);
  });

  it("refuses a version-2 context that is missing one of the five added fields", () => {
    for (const field of SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS) {
      const partial = { ...VERSION_2_CONTEXT } as Record<string, unknown>;
      delete partial[field];
      expectContractCode(
        () => computeSourceRequestSha256V2(partial as unknown as SourceRequestContextV2),
        "invalid-shape",
      );
    }
    // Positive control: the complete context projects.
    expect(computeSourceRequestSha256V2(VERSION_2_CONTEXT)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps the version-1 context closed against the five version-2 fields", () => {
    for (const field of SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS) {
      expectContractCode(
        () =>
          computeSourceRequestSha256({
            ...VERSION_1_CONTEXT,
            [field]: null,
          } as unknown as SourceRequestContextV1),
        "invalid-shape",
      );
    }
    expect(computeSourceRequestSha256(VERSION_1_CONTEXT)).toBe(VERSION_1_GOLDEN_SHA256);
  });
});

/** The comparison and nominations `docsfab run` retains on an update request. */
const READER_EVIDENCE_REQUEST = {
  comparisonRequest: { kind: "base-head", baseRevision: "b".repeat(40), headRevision: REVISION },
  readerSources: [{ role: "current-documentation", path: "docs/retention.md" }],
};

/** `CREATE_REQUEST` pinned to version 3, the request-intent version main defined. */
const VERSION_3_GOLDEN_SHA256 = "30eaab7fd3e7c75ec7d5ff24b3bafab7ee62f427027ed1c2027f7df4a4f3b1fc";

/** `CREATE_REQUEST` pinned to version 4; its body must not move silently. */
const VERSION_4_GOLDEN_SHA256 = "b7cfd3f9f4b5ccc42ec4bc037df4d2193f42bb478d0fe6d7731c46fff2352579";

const REQUEST_INTENT = { schemaVersion: 1, kind: "recorded-intent", sha256: sha("intent") };

describe("source request projection versions 3 through 5", () => {
  it("classifies every run-request field exactly once, from one table", () => {
    const classified = Object.keys(SOURCE_REQUEST_FIELD_CLASSES);
    const partition = [
      ...SOURCE_REQUEST_RESOLVED_FIELDS,
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V5,
      ...SOURCE_REQUEST_PENDING_CONTINUATION_FIELDS,
    ];
    expect([...partition].sort()).toEqual([...classified].sort());
    expect(new Set(partition).size).toBe(partition.length);
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V3_ADDITIONS).toEqual(["requestIntent"]);
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V4_ADDITIONS).toEqual([
      "instructionContext",
      "readerEvidenceRequest",
    ]);
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V3).toEqual([
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V2,
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V3_ADDITIONS,
    ]);
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V4).toEqual([
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V3,
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V4_ADDITIONS,
    ]);
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V5_ADDITIONS).toEqual(["prReviewBasis"]);
    expect(SOURCE_REQUEST_PROJECTED_FIELDS_V5).toEqual([
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V4,
      ...SOURCE_REQUEST_PROJECTED_FIELDS_V5_ADDITIONS,
    ]);
  });

  it("selects version 3 for a recorded request intent, which moves the digest", () => {
    for (const request of [CREATE_REQUEST, UPDATE_REQUEST]) {
      const withIntent = { ...request, requestIntent: REQUEST_INTENT };
      expect(selectSourceRequestProjectionVersion(withIntent)).toBe(3);
      expect(project(withIntent)).toBe(project(withIntent, { projectionVersion: 3 }));
      expect(project(withIntent)).not.toBe(
        project({ ...request, requestIntent: { ...REQUEST_INTENT, sha256: sha("other") } }),
      );
      // Versions 1 and 2 cannot represent it, and the refusal names it.
      for (const projectionVersion of [1, 2]) {
        expect(() => project(withIntent, { projectionVersion })).toThrow(
          /projection-unversioned\. Field .*request\.requestIntent/u,
        );
      }
    }
  });

  it("selects version 4 for a retained comparison or live-agent context and represents it", () => {
    for (const [field, value] of [
      ["readerEvidenceRequest", READER_EVIDENCE_REQUEST],
      ["instructionContext", "The operator is preparing the export limits release."],
    ] as const) {
      for (const base of [UPDATE_REQUEST, { ...UPDATE_REQUEST, requestIntent: REQUEST_INTENT }]) {
        const request = { ...base, [field]: value };
        expect(selectSourceRequestProjectionVersion(request)).toBe(4);
        const digest = project(request);
        expect(digest).toBe(project(request, { projectionVersion: 4 }));
        expect(digest).not.toBe(project({ ...base, [field]: null }));
        // Versions 1 to 3 cannot represent it and refuse, naming the field.
        for (const projectionVersion of [1, 2, 3]) {
          expect(() => project(request, { projectionVersion })).toThrow(
            new RegExp(`projection-unversioned\\. Field .*request\\.${field}`, "u"),
          );
        }
      }
    }
    // The request intent stays in the version-4 body.
    expect(project({ ...UPDATE_REQUEST, readerEvidenceRequest: READER_EVIDENCE_REQUEST })).not.toBe(
      project({
        ...UPDATE_REQUEST,
        readerEvidenceRequest: READER_EVIDENCE_REQUEST,
        requestIntent: REQUEST_INTENT,
      }),
    );
    // Version 4 leaves the version-1 and version-2 digests where they were.
    expect(project(CREATE_REQUEST)).toBe(VERSION_1_GOLDEN_SHA256);
    expect(project(UPDATE_REQUEST)).toBe(UPDATE_REQUEST_V2_GOLDEN_SHA256);
  });

  it("pins the version-3 and version-4 digests of the canonical request", () => {
    const versionThree: SourceRequestContextV3 = { ...VERSION_2_CONTEXT, requestIntent: null };
    const versionFour: SourceRequestContextV4 = {
      ...versionThree,
      instructionContext: null,
      readerEvidenceRequest: null,
    };
    expect(project(CREATE_REQUEST, { projectionVersion: 3 })).toBe(VERSION_3_GOLDEN_SHA256);
    expect(computeSourceRequestSha256V3(versionThree)).toBe(VERSION_3_GOLDEN_SHA256);
    expect(project(CREATE_REQUEST, { projectionVersion: 4 })).toBe(VERSION_4_GOLDEN_SHA256);
    expect(computeSourceRequestSha256V4(versionFour)).toBe(VERSION_4_GOLDEN_SHA256);
    expect(
      new Set([VERSION_2_GOLDEN_SHA256, VERSION_3_GOLDEN_SHA256, VERSION_4_GOLDEN_SHA256]).size,
    ).toBe(3);
  });

  it("still refuses a field outside the run request, naming it and why", () => {
    let refusal: unknown;
    try {
      project({
        ...UPDATE_REQUEST,
        readerEvidenceRequest: READER_EVIDENCE_REQUEST,
        futureField: 1,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SourceEvidenceContractError);
    expect((refusal as SourceEvidenceContractError).code).toBe("projection-unversioned");
    expect((refusal as SourceEvidenceContractError).field).toBe("request.futureField");
    expect((refusal as Error).message).toBe(
      "Source-evidence contract rejected: projection-unversioned. Field request.futureField: source request projection version 4 does not represent it, so a source binding cannot commit to the request.",
    );
    // A key that is not identifier-shaped is counted, never echoed.
    expect(() => project({ ...UPDATE_REQUEST, "bad key\n": 1 })).toThrow(
      "Field 1 unnamed request field: ",
    );
  });
});
