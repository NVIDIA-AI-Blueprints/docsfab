// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

// Counts cross-module checkpoint decodes so the history test below can pin the
// decode cost of a multi-lease history; behavior is passed through unchanged.
const checkpointDecodes = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/execution/lease-contracts.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/execution/lease-contracts.js")>();
  return {
    ...original,
    decodeExecutionCheckpoint: (...args: Parameters<typeof original.decodeExecutionCheckpoint>) => {
      checkpointDecodes.count += 1;
      return original.decodeExecutionCheckpoint(...args);
    },
  };
});

import {
  createSearchLimitation,
  createSearchProbe,
  createSearchProgressEvidence,
  createSearchProgressExecutionAuthority,
  createSearchProgressEvent,
  createSearchProgressObservation,
  createSearchProgressPolicy,
  createSearchRemainingWorkRationale,
  createSearchTarget,
  parseSearchProgressEvidence,
  serializeSearchProgressEvidence,
  type SearchLimitationCategory,
  type SearchLimitationV1,
  type SearchProbeOutcome,
  type SearchProbeV1,
  type SearchProgressEventCategory,
  type SearchProgressEventV1,
  type SearchProgressExecutionAuthorityV1,
  type SearchProgressObservationV1,
  type SearchTargetV1,
} from "../src/search/index.js";
import {
  createExecutionCheckpoint,
  createExecutionLeaseIdentity,
  createExecutionLeasePolicy,
  createExecutionLeaseState,
  decideExecutionLeaseRenewal,
  type ExecutionCheckpointReason,
  type ExecutionCheckpointV1,
  type ExecutionLeaseDecisionV1,
  type ExecutionLeaseStateV1,
  type ExecutionStopReason,
} from "../src/execution/index.js";
import { configureCredential } from "./helpers/configured-credential.js";

const SHA = (digit: string) => digit.repeat(64);
const REVISION = "a".repeat(40);

describe("deterministic search progress and saturation", () => {
  it("recommends renewal when unique evidence and required-probe coverage are productive", () => {
    const target = targetFixture();
    const probes = [probeFixture(target, "exact", "no-match", "1")];
    const observation = observationFixture({
      target,
      probes,
      leaseNumber: 1,
      events: [
        eventFixture(target, probes, [], {
          category: "evidence-produced",
          operation: "a",
          probe: probes[0],
        }),
      ],
    });
    const evidence = finish({ target, probes, observations: [observation] });

    expect(evidence.recommendation).toMatchObject({
      recommendation: "renew",
      disposition: "search-still-productive",
      saturation: { status: "productive", observationSha256: observation.observationSha256 },
      rationaleAuthority: "non-authoritative",
    });
    expect(evidence.recommendation.reasonCategories).toEqual([
      "new-evidence",
      "new-required-probe-coverage",
      "required-probes-remaining",
    ]);
  });

  it("converges repeated equivalent zero-yield targets on stopped-no-progress", () => {
    const target = targetFixture();
    const probes: SearchProbeV1[] = [];
    const first = observationFixture({
      target,
      probes,
      leaseNumber: 1,
      events: [eventFixture(target, probes, [], { category: "no-new-evidence", operation: "b" })],
    });
    const second = observationFixture({
      target,
      probes,
      leaseNumber: 2,
      previous: [first],
      events: [eventFixture(target, probes, [], { category: "no-new-evidence", operation: "b" })],
    });
    const evidence = finish({
      target,
      probes,
      observations: [first, second],
      policy: createSearchProgressPolicy({ repeatedEquivalentCallLimit: 1 }),
    });

    expect(second).toMatchObject({ repeatedEquivalentCallCount: 1, zeroYieldCallCount: 1 });
    expect(evidence.recommendation).toMatchObject({
      recommendation: "stop",
      disposition: "stopped-no-progress",
      saturation: { status: "saturated", observationSha256: second.observationSha256 },
    });
  });

  it.each([
    ["tool-failure", "tool-failure"],
    ["tool-failure", "index-incomplete"],
    ["authorization-denied", "access-denied"],
    ["unsupported-operation", "unsupported-operation"],
    ["governed-asset-defect", "evidence-unavailable"],
    ["governed-tool-defect", "tool-failure"],
    ["governance-denied", "evidence-unavailable"],
  ] as const)(
    "keeps %s/%s failures blocked and never bounded-not-found",
    (eventCategory, limitationCategory) => {
      const target = targetFixture();
      const blockedProbe = probeFixture(target, "exact", "blocked", "3");
      const limitations = [limitationFixture(target, [blockedProbe], limitationCategory)];
      const event = eventFixture(target, [blockedProbe], limitations, {
        category: eventCategory,
        operation: "c",
        probe: blockedProbe,
        limitation: limitations[0],
      });
      const observation = observationFixture({
        target,
        probes: [blockedProbe],
        limitations,
        leaseNumber: 1,
        events: [event],
      });
      const evidence = finish({
        target,
        probes: [blockedProbe],
        limitations,
        observations: [observation],
      });

      expect(evidence.recommendation.disposition).toBe("search-blocked");
      expect(evidence.recommendation.disposition).not.toBe("not-found-after-bounded-search");
      expect(evidence.recommendation.saturation).toEqual({
        status: "not-observed",
        observationSha256: null,
      });
    },
  );

  it("can establish bounded absence from complete probes and declining yield before a hard ceiling", () => {
    const target = targetFixture();
    const probes = [
      probeFixture(target, "exact", "no-match", "4"),
      probeFixture(target, "index", "no-match", "5"),
    ];
    const first = observationFixture({
      target,
      probes,
      leaseNumber: 1,
      events: probes.map((probe, index) =>
        eventFixture(target, probes, [], {
          category: "evidence-produced",
          operation: String(index + 1),
          probe,
          sequence: index + 1,
        }),
      ),
    });
    const second = observationFixture({
      target,
      probes,
      leaseNumber: 2,
      previous: [first],
      events: [
        eventFixture(target, probes, [], {
          category: "no-new-evidence",
          operation: "8",
          sequence: 1,
        }),
        eventFixture(target, probes, [], {
          category: "no-new-evidence",
          operation: "7",
          sequence: 2,
        }),
      ],
    });
    const third = observationFixture({
      target,
      probes,
      leaseNumber: 3,
      previous: [first, second],
      events: [
        eventFixture(target, probes, [], {
          category: "no-new-evidence",
          operation: "9",
          sequence: 1,
        }),
        eventFixture(target, probes, [], {
          category: "no-new-evidence",
          operation: "6",
          sequence: 2,
        }),
      ],
    });
    const evidence = finish({ target, probes, observations: [first, second, third] });

    expect([first.yieldScore, second.yieldScore, third.yieldScore]).toEqual([4, 0, 0]);
    expect(third.remainingRequiredProbeIds).toEqual([]);
    expect(evidence.recommendation).toMatchObject({
      recommendation: "stop",
      disposition: "not-found-after-bounded-search",
      saturation: { status: "saturated", observationSha256: third.observationSha256 },
    });
  });

  it("decodes each execution checkpoint once when parsing a multi-lease observation history", () => {
    // Observation k binds observations 1..k-1. Re-decoding that prefix inside
    // every history step made parsing cost n * 2^n checkpoint decodes (2, 8,
    // 24, 64 for one to four leases), which dominated hosted readiness runs.
    const target = targetFixture();
    const probes = [
      probeFixture(target, "exact", "no-match", "4"),
      probeFixture(target, "index", "no-match", "5"),
    ];
    const observations: SearchProgressObservationV1[] = [];
    for (let lease = 1; lease <= 4; lease += 1) {
      observations.push(
        observationFixture({
          target,
          probes,
          leaseNumber: lease,
          previous: [...observations],
          events: probes.map((probe, index) =>
            eventFixture(
              target,
              probes,
              [],
              lease === 1
                ? {
                    category: "evidence-produced",
                    operation: String(index + 1),
                    probe,
                    sequence: index + 1,
                  }
                : {
                    category: "no-new-evidence",
                    operation: String(lease * 2 + index),
                    sequence: index + 1,
                  },
            ),
          ),
        }),
      );
      const evidence = finish({ target, probes, observations });
      const serialized = serializeSearchProgressEvidence(evidence);
      checkpointDecodes.count = 0;
      const parsed = parseSearchProgressEvidence(serialized);

      expect(parsed.observations.map((item) => item.observationSha256)).toEqual(
        observations.map((item) => item.observationSha256),
      );
      expect(checkpointDecodes.count).toBe(lease);
    }
  });

  it("rejects fabricated projection-only execution objects and substituted target revisions", () => {
    const target = targetFixture();
    const probe = probeFixture(target, "exact", "no-match", "1");
    const event = eventFixture(target, [probe], [], {
      category: "evidence-produced",
      operation: "a",
      probe,
    });
    const fabricated = {
      leaseNumber: 1,
      checkpointSha256: SHA("1"),
      stateSha256: SHA("2"),
      identitySha256: SHA("3"),
      policySha256: SHA("4"),
    };
    expect(() =>
      createSearchProgressObservation({
        target,
        probes: [probe],
        limitations: [],
        execution: fabricated as unknown as SearchProgressExecutionAuthorityV1,
        events: [event],
      }),
    ).toThrowError(/invalid-execution-authority/u);

    const execution = executionFixture(target, [[event]]);
    const substituted = targetFixture("b".repeat(40));
    expect(() =>
      createSearchProgressObservation({
        target: substituted,
        probes: [],
        limitations: [],
        execution,
        events: [event],
      }),
    ).toThrowError(/invalid-execution-authority/u);
  });

  it("rejects repeated checkpoint/state digests and reordered or forked causal histories", () => {
    const target = targetFixture();
    const firstEvent = eventFixture(target, [], [], {
      category: "no-new-evidence",
      operation: "1",
    });
    const secondEvent = eventFixture(target, [], [], {
      category: "no-new-evidence",
      operation: "2",
    });
    const authority = executionFixture(target, [[firstEvent], [secondEvent]]);
    expect(() =>
      createSearchProgressExecutionAuthority({
        target,
        policy: authority.policy,
        identity: authority.identity,
        checkpoints: [authority.checkpoints[0]!, authority.checkpoints[0]!],
        decisions: authority.decisions,
      }),
    ).toThrowError(/invalid-execution-authority/u);
    expect(() =>
      createSearchProgressExecutionAuthority({
        target,
        policy: authority.policy,
        identity: authority.identity,
        checkpoints: [...authority.checkpoints].reverse(),
        decisions: authority.decisions,
      }),
    ).toThrowError(/invalid-execution-authority/u);
  });

  it("rejects per-lease event counts that disagree with authenticated checkpoint deltas", () => {
    const target = targetFixture();
    const first = eventFixture(target, [], [], {
      category: "no-new-evidence",
      operation: "1",
      sequence: 1,
    });
    const second = eventFixture(target, [], [], {
      category: "no-new-evidence",
      operation: "2",
      sequence: 2,
    });
    const execution = executionFixture(target, [[first, second]]);
    expect(() =>
      createSearchProgressObservation({
        target,
        probes: [],
        limitations: [],
        execution,
        events: [first],
      }),
    ).toThrowError(/invalid-observation/u);
  });

  it.each([
    ["workflow-completed", { finalReason: "workflow-completed" }],
    ["provider-terminal", { finalReason: "provider-requested", includeFinalDecision: true }],
    ["lease-budget", { maxLeases: 1 }],
    ["hard-ceiling", { hardToolCallCeiling: 1 }],
  ] as const)("never renews productive search at a terminal %s checkpoint", (_name, options) => {
    const target = targetFixture();
    const probe = probeFixture(target, "exact", "no-match", "1");
    const event = eventFixture(target, [probe], [], {
      category: "evidence-produced",
      operation: "a",
      probe,
    });
    const execution = executionFixture(target, [[event]], options);
    const observation = createSearchProgressObservation({
      target,
      probes: [probe],
      limitations: [],
      execution,
      events: [event],
    });
    const evidence = finish({
      target,
      probes: [probe],
      observations: [observation],
      execution,
    });
    expect(observation.yieldScore).toBeGreaterThan(0);
    expect(evidence.recommendation.recommendation).toBe("stop");
    expect(evidence.recommendation.renewable).toBe(false);
    expect(evidence.recommendation.reasonCategories).toContain("execution-denied");
  });

  it.each([
    ["workflow-completed", { finalReason: "workflow-completed" }],
    ["hard-ceiling", { hardToolCallCeiling: 1 }],
  ] as const)("preserves found-first disposition for positive evidence at %s", (_name, options) => {
    const target = targetFixture();
    const probe = probeFixture(target, "exact", "match", "1");
    const event = eventFixture(target, [probe], [], {
      category: "evidence-produced",
      operation: "a",
      probe,
    });
    const execution = executionFixture(target, [[event]], options);
    const observation = createSearchProgressObservation({
      target,
      probes: [probe],
      limitations: [],
      execution,
      events: [event],
    });
    const evidence = finish({
      target,
      probes: [probe],
      observations: [observation],
      execution,
    });
    expect(evidence.recommendation).toMatchObject({
      renewable: false,
      recommendation: "stop",
      disposition: "found",
    });
  });

  it("preserves found-first disposition when another probe is authorization-denied", () => {
    const target = targetFixture();
    const match = probeFixture(target, "exact", "match", "1");
    const denied = probeFixture(target, "index", "blocked", "2");
    const limitations = [limitationFixture(target, [denied], "access-denied")];
    const events = [
      eventFixture(target, [match, denied], limitations, {
        category: "evidence-produced",
        operation: "a",
        probe: match,
        sequence: 1,
      }),
      eventFixture(target, [match, denied], limitations, {
        category: "authorization-denied",
        operation: "b",
        probe: denied,
        limitation: limitations[0],
        sequence: 2,
      }),
    ];
    const execution = executionFixture(target, [events]);
    const observation = createSearchProgressObservation({
      target,
      probes: [match, denied],
      limitations,
      execution,
      events,
    });
    const evidence = finish({
      target,
      probes: [match, denied],
      limitations,
      observations: [observation],
      execution,
    });
    expect(evidence.recommendation).toMatchObject({
      renewable: false,
      recommendation: "stop",
      disposition: "found",
    });
  });

  it("preserves valid bounded absence when saturated search ends workflow-completed", () => {
    const { evidence, observations } = boundedAbsenceWorkflowFixture();
    expect(evidence.recommendation).toMatchObject({
      renewable: false,
      recommendation: "stop",
      disposition: "not-found-after-bounded-search",
      saturation: {
        status: "saturated",
        observationSha256: observations.at(-1)!.observationSha256,
      },
    });
  });

  it.each([
    "hard-tool-call-ceiling",
    "cumulative-input-limit",
    "cumulative-output-limit",
    "cumulative-time-limit",
    "cost-unavailable",
    "cumulative-cost-limit",
    "provider-turn-limit",
    "lease-limit",
    "context-exhausted",
    "evidence-preservation-required",
    "security-denied",
    "authorization-denied",
  ] as const)(
    "does not preserve bounded absence when workflow completion also has %s",
    (reason) => {
      const { evidence } = boundedAbsenceWorkflowFixture([reason]);
      expect(evidence.recommendation.renewable).toBe(false);
      expect(evidence.recommendation.disposition).not.toBe("not-found-after-bounded-search");
      expect(["stopped-hard-ceiling", "search-blocked"]).toContain(
        evidence.recommendation.disposition,
      );
    },
  );

  it("keeps inconclusive terminal searches incomplete or blocked", () => {
    const target = targetFixture();
    const noEvidence = eventFixture(target, [], [], {
      category: "no-new-evidence",
      operation: "a",
    });
    const completedExecution = executionFixture(target, [[noEvidence]], {
      finalReason: "workflow-completed",
    });
    const incomplete = createSearchProgressObservation({
      target,
      probes: [],
      limitations: [],
      execution: completedExecution,
      events: [noEvidence],
    });
    expect(
      finish({
        target,
        probes: [],
        observations: [incomplete],
        execution: completedExecution,
      }).recommendation,
    ).toMatchObject({ renewable: false, disposition: "search-incomplete" });

    const blockedProbe = probeFixture(target, "exact", "blocked", "2");
    const limitations = [limitationFixture(target, [blockedProbe], "access-denied")];
    const denied = eventFixture(target, [blockedProbe], limitations, {
      category: "authorization-denied",
      operation: "b",
      probe: blockedProbe,
      limitation: limitations[0],
    });
    const deniedExecution = executionFixture(target, [[denied]]);
    const blocked = createSearchProgressObservation({
      target,
      probes: [blockedProbe],
      limitations,
      execution: deniedExecution,
      events: [denied],
    });
    expect(
      finish({
        target,
        probes: [blockedProbe],
        limitations,
        observations: [blocked],
        execution: deniedExecution,
      }).recommendation,
    ).toMatchObject({ renewable: false, disposition: "search-blocked" });
  });

  it("is byte-deterministic and keeps model rationale outside decision authority", () => {
    const build = (detail: string) => {
      const target = targetFixture();
      const probes = [probeFixture(target, "exact", "no-match", "6")];
      const observation = observationFixture({
        target,
        probes,
        leaseNumber: 1,
        events: [
          eventFixture(target, probes, [], {
            category: "evidence-produced",
            operation: "d",
            probe: probes[0],
          }),
        ],
      });
      return finish({ target, probes, observations: [observation], rationaleDetail: detail });
    };
    const first = build("7");
    const same = build("7");
    const differentRationale = build("8");
    const bytes = serializeSearchProgressEvidence(first);

    expect(serializeSearchProgressEvidence(same)).toBe(bytes);
    expect(serializeSearchProgressEvidence(parseSearchProgressEvidence(bytes))).toBe(bytes);
    expect(differentRationale.recommendation.disposition).toBe(first.recommendation.disposition);
    expect(differentRationale.recommendation.recommendation).toBe(
      first.recommendation.recommendation,
    );
    expect(differentRationale.rationale.rationaleSha256).not.toBe(first.rationale.rationaleSha256);
    expect(bytes).not.toContain("search for more docs");
  });

  it("rejects a non-plain progress policy input through contract-kit inert checks", () => {
    expect(() =>
      createSearchProgressPolicy(Object.create({ repeatedEquivalentCallLimit: 3 })),
    ).toThrowError(/invalid-policy/u);
  });

  it("cites a credential-shaped path and refuses only a configured credential in it", () => {
    const shaped = ["glpat", "A1b2C3d4E5f6G7h8J9k0"].join("-");
    const citedProbe = (path: string) => {
      const target = targetFixture();
      const declaration = target.requiredProbes[0]!;
      return createSearchProbe(
        {
          id: declaration.id,
          strategy: declaration.strategy,
          location: declaration.location,
          scopeSha256: SHA("1"),
          outcome: "match",
          matchCount: 1,
          evidenceSha256: SHA("2"),
          citations: [{ path, anchorSha256: SHA("9") }],
        },
        target,
      );
    };
    // A path that only looks like a credential is cited like any other (#1807),
    // and the progress evidence that carries it round-trips.
    const probe = citedProbe(`docs/${shaped}.md`);
    expect(probe.citations[0]!.path).toBe(`docs/${shaped}.md`);
    const target = targetFixture();
    const observation = observationFixture({
      target,
      probes: [probe],
      leaseNumber: 1,
      events: [
        eventFixture(target, [probe], [], {
          category: "evidence-produced",
          operation: "a",
          probe,
        }),
      ],
    });
    const evidence = finish({ target, probes: [probe], observations: [observation] });
    expect(parseSearchProgressEvidence(serializeSearchProgressEvidence(evidence))).toEqual(
      evidence,
    );
    configureCredential(shaped);
    expect(() => citedProbe(`docs/${shaped}.md`)).toThrowError(/invalid-probe/u);
  });

  it("preserves a tracked citation path containing a plus sign", () => {
    const target = targetFixture();
    const declaration = target.requiredProbes[0]!;
    const probe = createSearchProbe(
      {
        id: declaration.id,
        strategy: declaration.strategy,
        location: declaration.location,
        scopeSha256: SHA("1"),
        outcome: "match",
        matchCount: 1,
        evidenceSha256: SHA("2"),
        citations: [
          {
            path: "changelog.d/+analytics-full-payload.fixed.md",
            anchorSha256: SHA("9"),
          },
        ],
      },
      target,
    );
    const observation = observationFixture({
      target,
      probes: [probe],
      leaseNumber: 1,
      events: [
        eventFixture(target, [probe], [], {
          category: "evidence-produced",
          operation: "a",
          probe,
        }),
      ],
    });
    const evidence = finish({ target, probes: [probe], observations: [observation] });

    expect(parseSearchProgressEvidence(serializeSearchProgressEvidence(evidence))).toEqual(
      evidence,
    );
  });
});

function targetFixture(revision = REVISION): SearchTargetV1 {
  return createSearchTarget({
    id: "fern-config",
    targetKey: "fern-config",
    targetType: "artifact-existence",
    repository: { identitySha256: SHA("e"), revision },
    subjectSha256: SHA("f"),
    artifactClass: "configuration",
    requiredProbes: [
      { id: "exact", strategy: "exact-path", location: "repository-root" },
      { id: "index", strategy: "filename-index", location: "tracked-files" },
    ],
  });
}

function probeFixture(
  target: SearchTargetV1,
  id: "exact" | "index",
  outcome: SearchProbeOutcome,
  evidenceDigit: string,
): SearchProbeV1 {
  const declaration = target.requiredProbes.find((probe) => probe.id === id)!;
  return createSearchProbe(
    {
      id,
      strategy: declaration.strategy,
      location: declaration.location,
      scopeSha256: SHA(id === "exact" ? "1" : "2"),
      outcome,
      matchCount: outcome === "match" ? 1 : 0,
      evidenceSha256: SHA(evidenceDigit),
      citations: outcome === "match" ? [{ path: "docs/guide.md", anchorSha256: SHA("9") }] : [],
    },
    target,
  );
}

function limitationFixture(
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  category: SearchLimitationCategory,
): SearchLimitationV1 {
  return createSearchLimitation(
    {
      id: "blocked-probe",
      category,
      impact: "blocking",
      probeIds: probes.map((probe) => probe.id),
      detailSha256: SHA("b"),
    },
    target,
    probes,
  );
}

function eventFixture(
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  limitations: readonly SearchLimitationV1[],
  input: {
    category: SearchProgressEventCategory;
    operation: string;
    probe?: SearchProbeV1;
    limitation?: SearchLimitationV1;
    sequence?: number;
  },
): SearchProgressEventV1 {
  return createSearchProgressEvent(
    {
      sequence: input.sequence ?? 1,
      category: input.category,
      operationSha256: SHA(input.operation),
      probeId: input.probe?.id ?? null,
      probeSha256: input.probe?.probeSha256 ?? null,
      evidenceSha256:
        input.category === "evidence-produced" ? (input.probe?.evidenceSha256 ?? null) : null,
      limitationSha256: input.limitation?.limitationSha256 ?? null,
      citations: input.probe?.citations ?? [],
    },
    target,
    probes,
    limitations,
  );
}

function observationFixture(input: {
  target: SearchTargetV1;
  probes: readonly SearchProbeV1[];
  limitations?: readonly SearchLimitationV1[];
  leaseNumber: number;
  events: readonly SearchProgressEventV1[];
  previous?: readonly SearchProgressObservationV1[];
}): SearchProgressObservationV1 {
  const leaseEvents = [
    ...(input.previous ?? []).map((observation) => observation.events),
    [...input.events],
  ];
  const execution = executionFixture(input.target, leaseEvents);
  return createSearchProgressObservation({
    target: input.target,
    probes: input.probes,
    limitations: input.limitations ?? [],
    execution,
    events: input.events,
    previousObservations: input.previous ?? [],
  });
}

function finish(input: {
  target: SearchTargetV1;
  probes: readonly SearchProbeV1[];
  limitations?: readonly SearchLimitationV1[];
  observations: readonly SearchProgressObservationV1[];
  policy?: ReturnType<typeof createSearchProgressPolicy>;
  execution?: SearchProgressExecutionAuthorityV1;
  rationaleDetail?: string;
}) {
  const current = input.observations.at(-1)!;
  const rationale = createSearchRemainingWorkRationale({
    target: input.target,
    category: current.remainingRequiredProbeIds.length > 0 ? "required-probes" : "none",
    remainingRequiredProbeIds: current.remainingRequiredProbeIds,
    remainingWorkCount: current.remainingRequiredProbeIds.length,
    detailSha256: SHA(input.rationaleDetail ?? "c"),
    citations: [],
  });
  const execution =
    input.execution ??
    executionFixture(
      input.target,
      input.observations.map((observation) => observation.events),
    );
  return createSearchProgressEvidence({
    policy: input.policy ?? createSearchProgressPolicy(),
    execution,
    target: input.target,
    probes: input.probes,
    limitations: input.limitations ?? [],
    observations: input.observations,
    rationale,
  });
}

function boundedAbsenceWorkflowFixture(finalStopReasons?: readonly ExecutionStopReason[]) {
  const target = targetFixture();
  const probes = [
    probeFixture(target, "exact", "no-match", "4"),
    probeFixture(target, "index", "no-match", "5"),
  ];
  const leases = [
    probes.map((probe, index) =>
      eventFixture(target, probes, [], {
        category: "evidence-produced",
        operation: String(index + 1),
        probe,
        sequence: index + 1,
      }),
    ),
    [
      eventFixture(target, probes, [], {
        category: "no-new-evidence",
        operation: "6",
        sequence: 1,
      }),
      eventFixture(target, probes, [], {
        category: "no-new-evidence",
        operation: "7",
        sequence: 2,
      }),
    ],
    [
      eventFixture(target, probes, [], {
        category: "no-new-evidence",
        operation: "8",
        sequence: 1,
      }),
      eventFixture(target, probes, [], {
        category: "no-new-evidence",
        operation: "9",
        sequence: 2,
      }),
    ],
  ];
  const observations: SearchProgressObservationV1[] = [];
  for (let index = 0; index < leases.length; index += 1) {
    const execution = executionFixture(
      target,
      leases.slice(0, index + 1),
      index === leases.length - 1 ? { finalReason: "workflow-completed", finalStopReasons } : {},
    );
    observations.push(
      createSearchProgressObservation({
        target,
        probes,
        limitations: [],
        execution,
        events: leases[index]!,
        previousObservations: observations,
      }),
    );
  }
  const execution = executionFixture(target, leases, {
    finalReason: "workflow-completed",
    finalStopReasons,
  });
  return {
    evidence: finish({ target, probes, observations, execution }),
    observations,
  };
}

function executionFixture(
  target: SearchTargetV1,
  leases: readonly (readonly SearchProgressEventV1[])[],
  options: {
    finalReason?: ExecutionCheckpointReason;
    maxLeases?: number;
    hardToolCallCeiling?: number;
    includeFinalDecision?: boolean;
    finalStopReasons?: readonly ExecutionStopReason[];
  } = {},
) {
  const executedCounts = leases.map(
    (events) =>
      events.filter(
        (event) => !["authorization-denied", "governance-denied"].includes(event.category),
      ).length,
  );
  const callsPerLease = Math.max(1, executedCounts[0] ?? 1);
  if (
    executedCounts.slice(0, -1).some((count) => count !== callsPerLease) ||
    executedCounts.some((count) => count > callsPerLease)
  )
    throw new Error("invalid test lease shape");
  const policy = createExecutionLeasePolicy({
    callsPerLease,
    maxLeases: options.maxLeases ?? 4,
    hardToolCallCeiling: options.hardToolCallCeiling ?? callsPerLease * (options.maxLeases ?? 4),
    maxProviderTurns: 16,
    maxCompactions: 4,
    cumulative: { maxInputTokens: 10_000, maxOutputTokens: 10_000, maxElapsedMs: 10_000 },
  });
  const identity = createExecutionLeaseIdentity({
    inferenceAttempt: 1,
    retriesConsumed: 0,
    authorizationSha256: null,
    repositoryRevision: target.repository.revision,
    contextPacketSha256: null,
    evidenceSha256: SHA("c"),
    toolPolicySha256: SHA("d"),
    contextAuthoritySha256: SHA("e"),
    policySha256: policy.policySha256,
  });
  const checkpoints: ExecutionCheckpointV1[] = [];
  const decisions: ExecutionLeaseDecisionV1[] = [];
  let previousState: ExecutionLeaseStateV1 | undefined;
  const totals = {
    requested: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    governanceBlocked: 0,
  };
  for (let index = 0; index < leases.length; index += 1) {
    const events = leases[index]!;
    const succeeded = events.filter(
      (event) => event.category === "evidence-produced" || event.category === "no-new-evidence",
    ).length;
    const denied = events.filter((event) => event.category === "authorization-denied").length;
    const governanceBlocked = events.filter(
      (event) => event.category === "governance-denied",
    ).length;
    const failed = events.length - succeeded - denied - governanceBlocked;
    const executed = succeeded + failed;
    totals.requested += events.length;
    totals.executed += executed;
    totals.succeeded += succeeded;
    totals.failed += failed;
    totals.denied += denied;
    totals.governanceBlocked += governanceBlocked;
    const state = createExecutionLeaseState(
      {
        leaseNumber: index + 1,
        leaseExecutedToolCalls: executed,
        providerTurns: index + 1,
        compactions: 0,
        toolCalls: { ...totals },
        cumulativeInputTokens: index + 1,
        cumulativeOutputTokens: index + 1,
        elapsedMs: index + 1,
        cost: { status: "known", microusd: 0 },
        lastCheckpointSha256: checkpoints.at(-1)?.checkpointSha256 ?? null,
      },
      policy,
      previousState,
    );
    const checkpoint = createExecutionCheckpoint({
      policy,
      identity,
      state,
      reason:
        index === leases.length - 1 && options.finalReason
          ? options.finalReason
          : "lease-exhausted",
      ...(checkpoints.length > 0 ? { previous: checkpoints.at(-1)! } : {}),
    });
    checkpoints.push(checkpoint);
    previousState = state;
    if (index < leases.length - 1) {
      decisions.push(
        decideExecutionLeaseRenewal({
          policy,
          identity,
          checkpoint,
          ...(index > 0
            ? { history: { checkpoints: checkpoints.slice(0, -1), decisions: [...decisions] } }
            : {}),
        }),
      );
    }
  }
  if (options.includeFinalDecision || options.finalStopReasons) {
    const checkpoint = checkpoints.at(-1)!;
    decisions.push(
      decideExecutionLeaseRenewal({
        policy,
        identity,
        checkpoint,
        ...(options.finalStopReasons ? { stopReasons: options.finalStopReasons } : {}),
        ...(checkpoints.length > 1
          ? { history: { checkpoints: checkpoints.slice(0, -1), decisions: [...decisions] } }
          : {}),
      }),
    );
  }
  return createSearchProgressExecutionAuthority({
    target,
    policy,
    identity,
    checkpoints,
    decisions,
  });
}
