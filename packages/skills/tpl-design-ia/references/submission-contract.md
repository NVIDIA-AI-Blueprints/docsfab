# IA analysis submission

Return one JSON object with exactly these top-level fields:

```json
{
  "schemaVersion": 1,
  "kind": "docsfab-ia-analysis-submission",
  "repository": {"revision": "<host revision>", "contentDigest": "<host digest>", "indexDigest": "<host index digest>"},
  "task": {"scope": "<host scope>", "mode": "<host mode>"},
  "design": {"status": "recommendation-ready", "useCases": [], "recommendation": {}, "rejections": [], "openDecisions": []},
  "artifacts": {"ontology": {}, "iaCandidates": {}, "navigationEvaluation": {}}
}
```

Placeholders above describe the shape; replace them with the actual host values
and supported proposal. Include `task.targetNodeId` exactly when the host supplied
it. Do not emit artifact envelopes, hashes, a skill identity, or an approval;
the host derives and seals those.

## Evidence and ontology

An evidence item is `{"nodeId":"<observed ID>","path":"<observed source path>"}`;
an optional `anchor` must belong to that node. Never invent IDs or paths.

`ontology` has exactly `entities` and `relationships` arrays:

- Entity: `id`, `label`, `kind`, `evidence`.
- Entity kinds: `actor`, `user-job`, `workflow-stage`, `capability`, `concept`,
  `component`, `resource`, `artifact`, `configuration`, `constraint`,
  `failure-mode`, `outcome`.
- Relationship: `subject`, `predicate`, `object`, `evidence`. Subject/object name
  declared entities. Predicates: `is-a`, `part-of`, `requires`, `precedes`,
  `operates-on`, `consumes`, `produces`, `configures`, `validates`, `fails-with`,
  `resolved-by`, `documented-by`.

## Candidates and recommendation

`iaCandidates` has `scope`, optional matching `targetNodeId`, `candidates`,
`recommendedCandidateId`, `rejectedCandidates`, and `openDecisions`.

Each candidate has `id`, `primaryAxis`, `secondaryAxes`, `score`, `groups`, and
`evidence`. Axes are `reader-job`, `lifecycle`, `capability`, `resource`, `persona`,
`environment`, or `component`. Scores are declared analysis judgments, not an
independent verification result. Each group has `id`, `label`, `axis`, `members`
(observed node IDs), `canonicalPath`, and `evidence`.

Candidate rejection items contain `candidateId` and `reason`. Reasons are
`lower-score`, `insufficient-evidence`, `mixed-axis`, `unstable-urls`,
`ambiguous-placement`, or `policy-conflict`. Candidate open decisions contain
`id`, `kind`, and `evidence`; kinds are `axis`, `placement`, `canonical-home`,
`label`, or `redirect`.

`design.useCases` items contain `id`, `actor`, `trigger`, `goal`, `input`,
`outcome`, and `evidence`. The optional `design.recommendation` contains
`candidateId`, `primaryAxis`, `groups` (each `id` and `memberNodeIds`), `rationale`,
and `evidence`. Design rejection items contain `candidateId`, `primaryAxis`,
`reason`, `rationale`, and `evidence`. These must agree with the candidate set.

Design open decisions contain `id`, `kind`, `question`, `blocking`, `evidence`,
and optional `evidenceGap`. Explain a missing fact rather than filling it in.

## Navigation exercise

`navigationEvaluation.tasks` preserves every host query's exact `id` and `query`
in the supplied order, adding `expectedNodeIds` and `acceptableNodeIds` from
observed nodes. These are proposed destinations for this structural exercise,
not canonical answers or human research observations.

`navigationEvaluation.results` contains `taskId`, `rankedNodeIds`, and `outcome`
(`matched`, `ambiguous`, or `no-result`) for each task. Report the analysis's actual
ranking, including ambiguity and unsupported queries. Omit `metrics`; the host
recomputes them. Do not claim independent audience evidence from these numbers.

If a recommendation is not supported, set `design.status` to `needs-human-input`,
omit `design.recommendation`, return the grounded ontology only in `artifacts`,
and state the blocking decisions or evidence gaps. The host preserves this stop;
it is not approval to apply a plan.
