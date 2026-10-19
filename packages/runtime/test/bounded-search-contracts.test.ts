// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BoundedSearchContractError,
  createBoundedSearchEvidence,
  createSearchConfidence,
  createSearchCoverage,
  createSearchFinding,
  createSearchLimitation,
  createSearchProbe,
  createSearchTarget,
  parseBoundedSearchEvidence,
  SEARCH_ARTIFACT_REQUIRED_PROBES,
  SEARCH_COMPLETE_COVERAGE_RUBRIC_VERSION,
  serializeBoundedSearchEvidence,
  type BoundedSearchEvidenceV1,
  type SearchDisposition,
  type SearchArtifactClass,
  type SearchLimitationCategory,
  type SearchProbeOutcome,
  type SearchProbeDeclarationV1,
  type SearchProbeV1,
  type SearchTargetV1,
} from "../src/search/index.js";

const SHA = {
  repository: "1".repeat(64),
  subject: "2".repeat(64),
  scopeA: "3".repeat(64),
  scopeB: "4".repeat(64),
  evidenceA: "5".repeat(64),
  evidenceB: "6".repeat(64),
  anchor: "7".repeat(64),
  observation: "8".repeat(64),
  detail: "9".repeat(64),
} as const;
const REVISION = "a".repeat(40);

describe("bounded search evidence contracts", () => {
  it("round-trips deterministic positive evidence with minimized citations", () => {
    const evidence = buildEvidence({ disposition: "found", outcomes: ["match", "no-match"] });
    const serialized = serializeBoundedSearchEvidence(evidence);

    expect(parseBoundedSearchEvidence(serialized)).toEqual(evidence);
    expect(serializeBoundedSearchEvidence(parseBoundedSearchEvidence(serialized))).toBe(serialized);
    expect(evidence.finding).toMatchObject({
      disposition: "found",
      findingClass: "presence",
      citations: [{ path: "docs/guide.md", anchorSha256: SHA.anchor }],
    });
    expect(serialized).not.toContain("matched text");
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.probes)).toBe(true);
  });

  it("accepts a tracked citation path containing a plus sign", () => {
    const target = targetFixture("artifact-existence");
    const declaration = target.requiredProbes[0]!;
    const probe = createSearchProbe(
      {
        id: declaration.id,
        strategy: declaration.strategy,
        location: declaration.location,
        scopeSha256: SHA.scopeA,
        outcome: "match",
        matchCount: 1,
        evidenceSha256: SHA.evidenceA,
        citations: [
          {
            path: "changelog.d/+analytics-full-payload.fixed.md",
            anchorSha256: SHA.anchor,
          },
        ],
      },
      target,
    );
    const evidence = finishEvidence({
      target,
      probes: [probe],
      limitations: [],
      disposition: "found",
      saturation: "not-observed",
    });

    expect(parseBoundedSearchEvidence(serializeBoundedSearchEvidence(evidence))).toEqual(evidence);
  });

  it("accepts bounded absence only after all declared probes complete and saturate", () => {
    const evidence = buildEvidence({
      disposition: "not-found-after-bounded-search",
      outcomes: ["no-match", "no-match"],
      saturation: "saturated",
    });

    expect(evidence.coverage).toMatchObject({
      sufficient: true,
      completedProbeIds: ["docs-index", "exact-file"],
      incompleteProbeIds: [],
      blockerDisclosure: { status: "complete", undisclosedBlockerCount: 0 },
    });
    expect(evidence.confidence.level).toBe("bounded");
    expect(evidence.finding.findingClass).toBe("absence");
  });

  it("requires criterion-level evidence for documentation quality or completeness", () => {
    const target = targetFixture("rubric-coverage");
    const probes = probeFixtures(
      target,
      target.requiredProbes.map(() => "no-match"),
    );
    const evidence = finishEvidence({
      target,
      probes,
      limitations: [],
      disposition: "not-found-after-bounded-search",
      saturation: "saturated",
    });

    expect(evidence.target.targetType).toBe("rubric-coverage");
    expect(evidence.coverage.rubricCriteria).toEqual([
      { criterionId: "accuracy", probeIds: ["accuracy-rubric"], status: "assessed" },
      {
        criterionId: "navigation",
        probeIds: ["navigation-graph", "navigation-rubric"],
        status: "assessed",
      },
    ]);

    expectContractError(
      () =>
        createSearchTarget({
          id: "quality-check",
          targetKey: "docs-quality",
          targetType: "rubric-coverage",
          repository: { identitySha256: SHA.repository, revision: REVISION },
          subjectSha256: SHA.subject,
          requiredProbes: declarations(),
          rubric: {
            id: "docs-quality",
            version: "v1",
            criteria: [{ id: "accuracy", kind: "accuracy", requiredProbeIds: ["exact-file"] }],
          },
        }),
      "invalid-target",
    );
  });

  it.each(Object.keys(SEARCH_ARTIFACT_REQUIRED_PROBES) as SearchArtifactClass[])(
    "requires the closed %s artifact probe policy",
    (artifactClass) => {
      const policy = SEARCH_ARTIFACT_REQUIRED_PROBES[artifactClass];
      const requiredProbes = policy.map((pair, index) => ({
        id: `required-${index}`,
        strategy: pair.strategy,
        location: pair.location,
      }));
      expect(
        createSearchTarget({
          id: `${artifactClass}-check`,
          targetKey: `${artifactClass}-target`,
          targetType: "artifact-existence",
          repository: { identitySha256: SHA.repository, revision: REVISION },
          subjectSha256: SHA.subject,
          artifactClass,
          requiredProbes,
        }).probePolicy,
      ).toEqual({
        id: "docsfab-bounded-search-required-probes",
        version: "1.0.0",
      });

      expectContractError(
        () =>
          createSearchTarget({
            id: `${artifactClass}-check`,
            targetKey: `${artifactClass}-target`,
            targetType: "artifact-existence",
            repository: { identitySha256: SHA.repository, revision: REVISION },
            subjectSha256: SHA.subject,
            artifactClass,
            requiredProbes: [
              {
                id: "relabeled-a",
                strategy: "rubric-assessment",
                location: "documentation-tree",
              },
              { id: "relabeled-b", strategy: "rubric-assessment", location: "navigation" },
            ],
          }),
        "invalid-target",
      );
    },
  );

  it("rejects rubric criteria backed by relabeled filename probes", () => {
    expectContractError(
      () =>
        createSearchTarget({
          id: "quality-check",
          targetKey: "docs-completeness",
          targetType: "rubric-coverage",
          repository: { identitySha256: SHA.repository, revision: REVISION },
          subjectSha256: SHA.subject,
          requiredProbes: declarations(),
          rubric: {
            id: "docs-quality",
            version: "v1",
            criteria: [
              {
                id: "complete",
                kind: "completeness",
                requiredProbeIds: ["docs-index", "exact-file"],
              },
            ],
          },
        }),
      "invalid-target",
    );
  });

  it.each([
    ["search-still-productive", "productive", "inconclusive"],
    ["search-incomplete", "not-observed", "inconclusive"],
    ["stopped-no-progress", "saturated", "inconclusive"],
  ] as const)(
    "round-trips the %s inconclusive disposition",
    (disposition, saturation, findingClass) => {
      const evidence = buildEvidence({
        disposition,
        outcomes: ["no-match", "inconclusive"],
        saturation,
      });

      expect(parseBoundedSearchEvidence(serializeBoundedSearchEvidence(evidence))).toEqual(
        evidence,
      );
      expect(evidence.finding.findingClass).toBe(findingClass);
      expect(evidence.coverage.sufficient).toBe(false);
    },
  );

  it("uses one deterministic disposition precedence for adversarial overlaps", () => {
    const target = targetFixture("artifact-existence");

    const foundProbes = probeFixtures(target, ["blocked", "match"]);
    const foundCeiling = createSearchLimitation(
      {
        id: "hard-ceiling-limit",
        category: "hard-ceiling",
        impact: "blocking",
        probeIds: ["docs-index"],
        detailSha256: SHA.detail,
      },
      target,
      foundProbes,
    );
    expect(
      finishEvidence({
        target,
        probes: foundProbes,
        limitations: [foundCeiling],
        disposition: "found",
        saturation: "productive",
      }).finding.disposition,
    ).toBe("found");
    expectContractError(
      () =>
        finishEvidence({
          target,
          probes: foundProbes,
          limitations: [foundCeiling],
          disposition: "stopped-hard-ceiling",
          saturation: "productive",
        }),
      "invalid-confidence",
    );

    const blockedProbes = probeFixtures(target, ["no-match", "blocked"]);
    for (const [category, expected] of [
      ["hard-ceiling", "stopped-hard-ceiling"],
      ["access-denied", "search-blocked"],
    ] as const) {
      const limitation = createSearchLimitation(
        {
          id: `${category}-limit`,
          category,
          impact: "blocking",
          probeIds: ["exact-file"],
          detailSha256: SHA.detail,
        },
        target,
        blockedProbes,
      );
      expect(
        finishEvidence({
          target,
          probes: blockedProbes,
          limitations: [limitation],
          disposition: expected,
          saturation: "productive",
        }).finding.disposition,
      ).toBe(expected);
      expectContractError(
        () =>
          finishEvidence({
            target,
            probes: blockedProbes,
            limitations: [limitation],
            disposition: "search-still-productive",
            saturation: "productive",
          }),
        "invalid-confidence",
      );
    }

    const incompleteProbes = probeFixtures(target, ["no-match", "inconclusive"]);
    expectContractError(
      () =>
        finishEvidence({
          target,
          probes: incompleteProbes,
          limitations: [],
          disposition: "search-incomplete",
          saturation: "saturated",
        }),
      "invalid-confidence",
    );
    expect(
      finishEvidence({
        target,
        probes: incompleteProbes,
        limitations: [],
        disposition: "stopped-no-progress",
        saturation: "saturated",
      }).finding.disposition,
    ).toBe("stopped-no-progress");

    const completedProbes = probeFixtures(target, ["no-match", "no-match"]);
    expect(
      finishEvidence({
        target,
        probes: completedProbes,
        limitations: [],
        disposition: "search-incomplete",
        saturation: "not-observed",
      }).finding.disposition,
    ).toBe("search-incomplete");
  });

  it("does not confirm a rubric match while required local probes are blocked", () => {
    const target = targetFixture(
      "rubric-coverage",
      REVISION,
      SEARCH_COMPLETE_COVERAGE_RUBRIC_VERSION,
    );
    const probes = probeFixtures(target, ["match", "blocked", "blocked"]);
    const limitation = createSearchLimitation(
      {
        id: "unsupported-rubric-probes",
        category: "unsupported-operation",
        impact: "blocking",
        probeIds: ["navigation-graph", "navigation-rubric"],
        detailSha256: SHA.detail,
      },
      target,
      probes,
    );
    const evidence = finishEvidence({
      target,
      probes,
      limitations: [limitation],
      disposition: "search-blocked",
      saturation: "not-observed",
    });
    expect(evidence.coverage.sufficient).toBe(false);
    expect(evidence.confidence.level).toBe("blocked");
    expectContractError(
      () =>
        finishEvidence({
          target,
          probes,
          limitations: [limitation],
          disposition: "found",
          saturation: "not-observed",
        }),
      "invalid-confidence",
    );
    const completed = finishEvidence({
      target,
      probes: probeFixtures(target, ["match", "no-match", "no-match"]),
      limitations: [],
      disposition: "found",
      saturation: "not-observed",
    });
    expect(completed.coverage.sufficient).toBe(true);
    expect(completed.confidence.level).toBe("confirmed");
    const legacy = targetFixture("rubric-coverage");
    const legacyProbes = probeFixtures(legacy, ["match", "blocked", "blocked"]);
    const legacyLimit = createSearchLimitation(
      {
        id: "legacy-unsupported-rubric-probes",
        category: "unsupported-operation",
        impact: "blocking",
        probeIds: ["navigation-graph", "navigation-rubric"],
        detailSha256: SHA.detail,
      },
      legacy,
      legacyProbes,
    );
    const historical = finishEvidence({
      target: legacy,
      probes: legacyProbes,
      limitations: [legacyLimit],
      disposition: "found",
      saturation: "not-observed",
    });
    expect(parseBoundedSearchEvidence(serializeBoundedSearchEvidence(historical))).toEqual(
      historical,
    );
  });

  it.each([
    ["search-blocked", "access-denied"],
    ["stopped-hard-ceiling", "hard-ceiling"],
  ] as const)("round-trips the %s blocked disposition", (disposition, category) => {
    const target = targetFixture("artifact-existence");
    const probes = probeFixtures(target, ["no-match", "blocked"]);
    const limitation = createSearchLimitation(
      {
        id: `${category}-limit`,
        category,
        impact: "blocking",
        probeIds: ["exact-file"],
        detailSha256: SHA.detail,
      },
      target,
      probes,
    );
    const evidence = finishEvidence({
      target,
      probes,
      limitations: [limitation],
      disposition,
      saturation: "not-observed",
    });

    expect(evidence.finding.findingClass).toBe("blocked");
    expect(evidence.coverage.sufficient).toBe(false);
  });

  it("keeps finding identity stable across repository revisions while rebinding evidence", () => {
    const first = targetFixture("artifact-existence", "a".repeat(40));
    const second = targetFixture("artifact-existence", "b".repeat(40));

    expect(first.stableFindingId).toBe(second.stableFindingId);
    expect(first.targetSha256).not.toBe(second.targetSha256);
  });

  it.each([
    ["missing probe", ["no-match"] as SearchProbeOutcome[], "saturated" as const],
    [
      "inconclusive probe",
      ["no-match", "inconclusive"] as SearchProbeOutcome[],
      "saturated" as const,
    ],
    ["productive search", ["no-match", "no-match"] as SearchProbeOutcome[], "productive" as const],
    [
      "unsaturated search",
      ["no-match", "no-match"] as SearchProbeOutcome[],
      "not-observed" as const,
    ],
    ["positive match", ["match", "no-match"] as SearchProbeOutcome[], "saturated" as const],
  ])("rejects bounded absence with %s", (_name, outcomes, saturation) => {
    expectContractError(
      () =>
        buildEvidence({
          disposition: "not-found-after-bounded-search",
          outcomes,
          saturation,
        }),
      outcomes.length === 1 ? "invalid-confidence" : "invalid-confidence",
    );
  });

  it.each(["access-denied", "hard-ceiling"] as const)(
    "never turns a %s limitation into bounded absence",
    (category) => {
      const target = targetFixture("artifact-existence");
      const probes = probeFixtures(target, ["no-match", "blocked"]);
      const limitation = createSearchLimitation(
        {
          id: `${category}-limit`,
          category,
          impact: "blocking",
          probeIds: ["exact-file"],
          detailSha256: SHA.detail,
        },
        target,
        probes,
      );
      expectContractError(
        () =>
          finishEvidence({
            target,
            probes,
            limitations: [limitation],
            disposition: "not-found-after-bounded-search",
            saturation: "saturated",
          }),
        "invalid-confidence",
      );
    },
  );

  it("rejects incomplete blocker disclosure for bounded absence", () => {
    const target = targetFixture("artifact-existence");
    const probes = probeFixtures(target, ["no-match", "no-match"]);
    const coverage = createSearchCoverage({
      target,
      probes,
      limitations: [],
      blockerDisclosure: { status: "incomplete", undisclosedBlockerCount: 1 },
    });

    expectContractError(
      () =>
        createSearchConfidence({
          target,
          probes,
          coverage,
          limitations: [],
          disposition: "not-found-after-bounded-search",
          saturation: { status: "saturated", observationSha256: SHA.observation },
        }),
      "invalid-confidence",
    );
  });

  it("requires exact two-way linkage between blocked probes and blocking limitations", () => {
    const target = targetFixture("artifact-existence");
    const completed = probeFixtures(target, ["no-match", "no-match"]);
    expectContractError(
      () =>
        createSearchLimitation(
          {
            id: "invented-blocker",
            category: "access-denied",
            impact: "blocking",
            probeIds: ["docs-index"],
            detailSha256: SHA.detail,
          },
          target,
          completed,
        ),
      "invalid-limitation",
    );

    const blocked = probeFixtures(target, ["blocked", "no-match"]);
    expectContractError(
      () =>
        createSearchCoverage({
          target,
          probes: blocked,
          limitations: [],
          blockerDisclosure: { status: "complete", undisclosedBlockerCount: 0 },
        }),
      "invalid-coverage",
    );
  });

  it("rejects malformed, non-minimized, and noncanonical evidence", () => {
    const evidence = buildEvidence({ disposition: "found", outcomes: ["match", "no-match"] });

    const unknownField = structuredClone(evidence) as BoundedSearchEvidenceV1 & { prompt?: string };
    unknownField.prompt = "inspect everything";
    expectContractError(() => parseBoundedSearchEvidence(unknownField), "invalid-evidence");

    const absoluteCitation = structuredClone(evidence);
    absoluteCitation.probes[0]!.citations[0]!.path = "/Users/operator/repository/docs/guide.md";
    expectContractError(() => parseBoundedSearchEvidence(absoluteCitation), "invalid-probe");

    const credentialCitation = structuredClone(evidence);
    credentialCitation.probes[0]!.citations[0]!.path = `docs/glpat-${"x".repeat(20)}.md`;
    expectContractError(() => parseBoundedSearchEvidence(credentialCitation), "invalid-probe");

    const tampered = structuredClone(evidence);
    tampered.finding.findingSha256 = "f".repeat(64);
    expectContractError(() => parseBoundedSearchEvidence(tampered), "invalid-finding");

    const reordered = structuredClone(evidence);
    reordered.probes.reverse();
    expectContractError(() => parseBoundedSearchEvidence(reordered), "invalid-evidence");

    const noncanonicalJson = JSON.stringify(evidence);
    expect(() => parseBoundedSearchEvidence(noncanonicalJson)).toThrowError(
      expect.objectContaining({ code: "noncanonical-json" }),
    );
  });

  it("rejects recursive non-inert plain-data fixtures before invoking accessors", () => {
    const valid = buildEvidence({ disposition: "found", outcomes: ["match", "no-match"] });
    const fixtures: Array<[string, (candidate: any) => void]> = [
      [
        "custom prototype",
        (candidate) => {
          Object.setPrototypeOf(candidate.target.repository, { inherited: true });
        },
      ],
      [
        "symbol key",
        (candidate) => {
          candidate.target[Symbol("hidden")] = "value";
        },
      ],
      [
        "non-enumerable property",
        (candidate) => {
          Object.defineProperty(candidate.target, "hidden", { value: "value" });
        },
      ],
      [
        "extra array property",
        (candidate) => {
          candidate.probes.extra = "value";
        },
      ],
      [
        "non-enumerable array property",
        (candidate) => {
          Object.defineProperty(candidate.probes, "hidden", { value: "value" });
        },
      ],
      [
        "sparse array",
        (candidate) => {
          delete candidate.probes[0];
        },
      ],
      [
        "undefined value",
        (candidate) => {
          candidate.target.id = undefined;
        },
      ],
      [
        "array accessor",
        (candidate) => {
          Object.defineProperty(candidate.probes, "0", {
            enumerable: true,
            get: () => candidate.target,
          });
        },
      ],
    ];

    for (const [name, mutate] of fixtures) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      expectContractError(() => parseBoundedSearchEvidence(candidate), "invalid-evidence");
      expect(name).not.toBe("");
    }

    let getterCalls = 0;
    const accessor = structuredClone(valid) as any;
    Object.defineProperty(accessor.target.repository, "revision", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return REVISION;
      },
    });
    expectContractError(() => parseBoundedSearchEvidence(accessor), "invalid-evidence");
    expect(getterCalls).toBe(0);

    let proxyTraps = 0;
    const proxied = structuredClone(valid) as any;
    proxied.target = new Proxy(proxied.target, {
      getPrototypeOf: (candidate) => {
        proxyTraps += 1;
        return Reflect.getPrototypeOf(candidate);
      },
      ownKeys: (candidate) => {
        proxyTraps += 1;
        return Reflect.ownKeys(candidate);
      },
    });
    expectContractError(() => parseBoundedSearchEvidence(proxied), "invalid-evidence");
    expect(proxyTraps).toBe(0);

    const creatorInput = {
      id: "docs-file",
      targetKey: "operator-guide",
      targetType: "artifact-existence",
      repository: { identitySha256: SHA.repository, revision: REVISION },
      subjectSha256: SHA.subject,
      artifactClass: "documentation-artifact",
      requiredProbes: declarations(),
    } as any;
    Object.defineProperty(creatorInput.repository, "revision", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return REVISION;
      },
    });
    expectContractError(() => createSearchTarget(creatorInput), "invalid-target");
    expect(getterCalls).toBe(0);
  });

  it.each(["docs/operator guide.md", "docs/operator\nguide.md", "docs/operator\tguide.md"])(
    "rejects a content-bearing or control-bearing citation path: %s",
    (path) => {
      const evidence = structuredClone(
        buildEvidence({
          disposition: "found",
          outcomes: ["match", "no-match"],
        }),
      );
      evidence.probes.find((probe) => probe.outcome === "match")!.citations[0]!.path = path;
      expectContractError(() => parseBoundedSearchEvidence(evidence), "invalid-probe");
    },
  );

  it("rejects an under-declared target and unrestricted target fields", () => {
    expectContractError(
      () =>
        createSearchTarget({
          id: "docs-file",
          targetKey: "operator-guide",
          targetType: "artifact-existence",
          repository: { identitySha256: SHA.repository, revision: REVISION },
          subjectSha256: SHA.subject,
          artifactClass: "documentation-artifact",
          requiredProbes: [
            {
              id: "exact-file",
              strategy: "exact-path",
              location: "documentation-tree",
            },
          ],
        }),
      "invalid-target",
    );

    const target = structuredClone(targetFixture("artifact-existence")) as SearchTargetV1 & {
      arguments?: string[];
    };
    target.arguments = ["--all"];
    expectContractError(
      () =>
        parseBoundedSearchEvidence({
          ...buildEvidence({ disposition: "found", outcomes: ["match", "no-match"] }),
          target,
        }),
      "invalid-target",
    );
  });
});

function buildEvidence(input: {
  disposition: SearchDisposition;
  outcomes: SearchProbeOutcome[];
  saturation?: "saturated" | "productive" | "not-observed";
}): BoundedSearchEvidenceV1 {
  const target = targetFixture("artifact-existence");
  return finishEvidence({
    target,
    probes: probeFixtures(target, input.outcomes),
    limitations: [],
    disposition: input.disposition,
    saturation: input.saturation ?? "not-observed",
  });
}

function finishEvidence(input: {
  target: SearchTargetV1;
  probes: SearchProbeV1[];
  limitations: ReturnType<typeof createSearchLimitation>[];
  disposition: SearchDisposition;
  saturation: "saturated" | "productive" | "not-observed";
}): BoundedSearchEvidenceV1 {
  const coverage = createSearchCoverage({
    target: input.target,
    probes: input.probes,
    limitations: input.limitations,
    blockerDisclosure: { status: "complete", undisclosedBlockerCount: 0 },
  });
  const saturation =
    input.saturation === "not-observed"
      ? ({ status: input.saturation, observationSha256: null } as const)
      : ({ status: input.saturation, observationSha256: SHA.observation } as const);
  const confidence = createSearchConfidence({
    target: input.target,
    probes: input.probes,
    coverage,
    limitations: input.limitations,
    disposition: input.disposition,
    saturation,
  });
  const finding = createSearchFinding({
    target: input.target,
    probes: input.probes,
    limitations: input.limitations,
    coverage,
    confidence,
  });
  return createBoundedSearchEvidence({
    target: input.target,
    probes: input.probes,
    limitations: input.limitations,
    coverage,
    confidence,
    finding,
  });
}

function targetFixture(
  type: "artifact-existence" | "rubric-coverage",
  revision = REVISION,
  rubricVersion = "v1",
): SearchTargetV1 {
  const common = {
    id: "operator-guide-check",
    targetKey: "operator-guide",
    repository: { identitySha256: SHA.repository, revision },
    subjectSha256: SHA.subject,
    requiredProbes: type === "artifact-existence" ? declarations() : rubricDeclarations(),
  };
  return type === "artifact-existence"
    ? createSearchTarget({
        ...common,
        targetType: type,
        artifactClass: "documentation-artifact",
      })
    : createSearchTarget({
        ...common,
        targetType: type,
        rubric: {
          id: "docs-quality",
          version: rubricVersion,
          criteria: [
            { id: "accuracy", kind: "accuracy", requiredProbeIds: ["accuracy-rubric"] },
            {
              id: "navigation",
              kind: "navigation",
              requiredProbeIds: ["navigation-graph", "navigation-rubric"],
            },
          ],
        },
      });
}

function declarations(): SearchProbeDeclarationV1[] {
  return [
    { id: "exact-file", strategy: "exact-path", location: "documentation-tree" },
    { id: "docs-index", strategy: "documentation-inventory", location: "documentation-tree" },
  ];
}

function rubricDeclarations(): SearchProbeDeclarationV1[] {
  return [
    {
      id: "accuracy-rubric",
      strategy: "rubric-assessment",
      location: "documentation-tree",
    },
    { id: "navigation-rubric", strategy: "rubric-assessment", location: "navigation" },
    { id: "navigation-graph", strategy: "navigation-graph", location: "navigation" },
  ];
}

function probeFixtures(target: SearchTargetV1, outcomes: SearchProbeOutcome[]): SearchProbeV1[] {
  return outcomes.map((outcome, index) => {
    const declaration = target.requiredProbes[index]!;
    const match = outcome === "match";
    return createSearchProbe(
      {
        id: declaration.id,
        strategy: declaration.strategy,
        location: declaration.location,
        scopeSha256: index === 0 ? SHA.scopeA : SHA.scopeB,
        outcome,
        matchCount: match ? 1 : 0,
        evidenceSha256: index === 0 ? SHA.evidenceA : SHA.evidenceB,
        citations: match ? [{ path: "docs/guide.md", anchorSha256: SHA.anchor }] : [],
      },
      target,
    );
  });
}

function expectContractError(
  operation: () => unknown,
  code: BoundedSearchContractError["code"],
): void {
  expect(operation).toThrowError(BoundedSearchContractError);
  expect(operation).toThrowError(expect.objectContaining({ code }));
}
