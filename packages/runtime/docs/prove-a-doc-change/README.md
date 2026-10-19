# Prove a documentation change

<!-- Diataxis: how-to hub. -->

## Goal

Run a bounded campaign that records whether a proposed documentation change is
supported by deterministic checks and, when enabled, independent evaluation.

## When to use this

Use it when a patch needs stronger evidence than a prose success claim, or to
compare a small number of candidate improvements under a fixed budget.

## Tasks

1. Define the bounded change and success criteria in
   [bounded documentation improvement](bounded-doc-improvement.md); use the
   [campaign envelope contracts](../reference/contracts/bounded-doc-improvement.md)
   when preparing signed artifacts.
2. For capped multi-unit stewardship (≥2 fingerprint slots), use the
   [multi-unit dry-run procedure](multi-unit-doc-improvement.md).
3. Run the deterministic checks first; structural failure is never hidden by
   a semantic evaluation.
4. Consult [evaluation corpus](evaluation-corpus.md) and
   [semantic evaluation](semantic-evaluation.md) for the controlled
   evaluation boundary.
5. Retain the generated patch, run record, validation, and keep/discard
   decision for review.

## Related topics

- [MVP acceptance](mvp-acceptance.md)
- [MVP scorecard](mvp-scorecard.md)
- [Canonical catalog scorecard harness](catalog-scorecard.md)
- [Foundation-to-patch offline dogfood](foundation-to-patch-dogfood.md)
- [Run records](../reference/contracts/run-records.md)
