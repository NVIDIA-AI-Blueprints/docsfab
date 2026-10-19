# Maturity cascade known-answer evaluation

DocsFab ships a credential-free evaluation corpus for the G0–G5 documentation
maturity cascade. The corpus answers two product questions: whether the earliest
material gap is identified across different repository states, and whether the
same immutable revision produces the same findings and one-work-unit selection.

Run it from the repository root:

```sh
npm run evaluate:maturity-cascade
```

The command is read-only by default and writes its canonical JSON report to
standard output. To persist a report, name a new directory and explicitly
authorize the write:

```sh
npm run evaluate:maturity-cascade -- \
  --allow-write \
  --output-dir /absolute/path/to/new-report-directory
```

The publisher never overwrites an existing directory or report.

## Authority boundaries

Each fixture is materialized into a temporary, local Git repository. The same
production workspace boundary used by the maturity evaluators authenticates the
exact revision, canonical tracked quality policy, and every bounded source read.
The policy states requirements; it does not contain expected dispositions,
findings, or selected work. Scanner output is produced before the known-answer
baseline is loaded.

The offline evaluation calls the real G0–G5 assessment and ranking logic. It uses
the cascade's explicitly non-authoritative inspection seam with an empty tracker
snapshot because a credential-free fixture cannot authenticate a live GitLab
project. The report therefore says `productionTrackerCoverage:
"not-evaluated-offline"`; it is evidence for deterministic cascade behavior,
not for the production tracker observation boundary.

Raw maturity fingerprints bind the absolute repository path. The evaluation
checks those raw fingerprints for equality across five unchanged runs in the
same materialized repository. Portable known answers are separately labeled and
replace that host-specific repository identity with the logical dataset case ID.
They are evaluation projections, never production authority.

## Corpus and revision trajectory

The seven-case trajectory resolves one earlier gate and exposes the next. Each
predecessor/current pair is bound by its independently reviewed case digests;
the loader derives a bounded, content-addressed path diff from those exact
source snapshots. The report rejects a transition unless the prior selected
finding disappears and the reviewed next selection is exposed:

1. `no-doc` — G0 documentation surface absence.
2. `partial` — G1 journey and reference coverage gaps.
3. `broken-ia` — G2 page-boundary defect.
4. `monolithic` — G3 article modularity defect.
5. `stale-inaccurate` — G3 accuracy and freshness defects.
6. `polish-only` — G4 presentation defect.
7. `complete` — every deterministic check is satisfied and the cascade reaches
   `no-action` without inventing an improvement.

The eighth fixture, `human-decision`, has complete documentation but an explicit
unknown product-need decision. It must reach `needs-input`; the evaluator must
not guess applicability.

Dataset source bytes, case manifests, the baseline, both maturity catalog
digests, and the cascade algorithm version are content-addressed. A distinct
preparer and independent reviewer attest to the complete case-baseline binding
with separate Ed25519 keys. Only public keys and signatures are committed.

## Measurements and semantic scoring

Every case records five per-run latency observations, authenticated adapter and
selection-inspection call counts, and deterministic token usage. Deterministic
execution performs no model call, so its token usage is exactly zero.

An optional semantic scorer receives only a bounded, credential-scanned, frozen
projection of fixture source paths, bytes, and digests. It receives neither the
case's descriptive ID nor deterministic finding keys. The evaluator compares
returned major-finding keys locally and records the scorer's token usage. Its
result is always `advisory-only`: disagreement, malformed output, or scorer
failure does not change deterministic findings, selection, pass/fail state, or
write authorization.

Adapter and selection counts are incremented at the actual invocation
boundaries and recorded per repeated run; aggregate counts are sums of those
observations rather than values inferred from the fixture kind.

Failures are content-minimized and identify the case, gate, mismatched field,
expected and actual value or digest, and evidence digests. Negative controls
ensure plausible but unsupported findings—especially accessibility defects—do
not appear.
