# Layered Evaluation Protocol

The three layers are cumulative and profile-sensitive:

1. **Trustworthy information:** Can the information be relied on for its
   declared scope?
2. **Transferable understanding:** Does it build a coherent model that supports
   reasoning beyond memorized wording?
3. **Effective experience:** Can the intended user find and apply it with
   acceptable effort, risk, and friction?

Use four evidence classes and label each item:

- deterministic conformance;
- grounded judgment;
- outcome evaluation; and
- longitudinal observation.

Direct product evidence is stronger for correctness than a prose heuristic.
Direct task evidence is stronger for usability than an expert prediction.
Longitudinal evidence is stronger for sustained operation than one controlled
run. None replaces the others across all dimensions.

Evidence strength means:

- **direct:** an observed property or outcome of the frozen target under the
  declared conditions;
- **derived:** a reproducible transformation of identified direct evidence;
- **proxy:** an indirect correlate, heuristic, or expert prediction; and
- **none:** no usable evidence.

## Profile Application

Use `../../quality/profiles/docsfab-documentation-quality/profile.json` for the
DocsFab documentation set. The target's `scope_type` selects the required
dimensions. For a `documentation-set` target, every dimension the profile
lists under `required_dimensions_by_layer` is required, even when the set is
a single page. For an `individual-page` target, select the required dimensions
by page family, declared outcome class, and risk class. Record the basis for
the family classification and bind its evidence paths to the frozen target
paths. When a page is stored under a family-specific path, the declared family
must agree with that path. An API reference, conceptual guide, and
troubleshooting procedure must not be evaluated as interchangeable content.

The profile, not the evaluator, decides applicability. Set every required
dimension's applicability to `required`, and never assess it as
`not-applicable`. A target may lack content of a dimension's kind, for
example diagrams or an interactive surface. In that case, judge from evidence
whether the absence serves the declared audience and outcome. Otherwise
record `not-assessed` with evidence strength `none` and a limitation.

The profile is experimental and cannot produce a release-gating `pass` until
its human and agent outcome baselines, applicability decisions, and thresholds
are calibrated and approved. It defines provisional required dimensions and
gates, not universal weights. Keep
the dimension assessments, measures, evidence strength, confidence, and
limitations visible.

A future promoted profile must require verified successful outcomes, not just
the presence of a trial record. Apply its population-specific minimum attempt
and success-rate rules so one success cannot hide other failures or unverified
trials. Apply the profile's conditional-pass switch; never infer that
conditional pass is available from the schema vocabulary.

Record an entry in `outcomes.human` or `outcomes.agent` only for an attempt
that ran and that the evidence identifies. Each attempt keeps its own
`attempt_id`, unique across both populations. When no attempt ran for a
population, leave its list empty. Record the missing outcome evidence in the
affected dimensions and limitations. Never invent a placeholder attempt such
as `not-run`.

Use the profile's confidence anchors. Set each layer's confidence to no more
than its lowest required-dimension confidence. Set overall confidence to no
more than the lowest confidence among all required dimensions. Required
dimensions assessed as `not-assessed` count toward these limits. These limits
also apply to failing and insufficient-evidence results. Confidence in having
found a defect does not replace confidence in the required evidence. Do not
average confidence.

## Independence

A release-gating evaluator must not be the author. Give a clean evaluator the
frozen documentation, reference model, evidence, profile, and acceptance
criteria. Do not provide private authoring context or expected findings.

## Decision Precedence

1. For each layer, a nonempty `hard_gate_failures` list requires that layer's
   `decision` to be `fail`, including layers 2 and 3. Use only evidenced gates
   from the selected profile's vocabulary. Missing audience evidence alone
   does not invent a hard failure.
2. Include every layer hard-gate failure in the top-level
   `hard_gate_failures` list without duplicates. Any failing layer or
   top-level hard-gate failure requires `overall_decision: fail`.
3. Missing required evidence without an established failure ->
   `insufficient-evidence` or `human-review`. If a layer has both an established
   hard failure and missing evidence, keep its decision `fail` and preserve
   the missing evidence in its dimensions and limitations.
4. Open non-critical conditions permitted by the profile ->
   `conditional-pass`.
5. All required layer and constraint decisions pass -> `pass`.

Assurance-system health can explain confidence in preservation over time, but
it does not change a failing document into a passing one.

Before returning the artifacts, check these relationships from dimensions to
layers to the overall result, then copy the decisions and confidence into the
report. Do not choose the layer decision independently from its recorded
failures, erase a supported failure to make an artifact valid, or upgrade
missing evidence to a pass. A valid negative evaluation is a completed
evaluation; an internally contradictory artifact is not.

## Finding reconciliation

Create a reconciliation row in working notes for each critical or major
originating finding. Record its source review, stable originating ID, evidence
locator, evaluator finding ID when consolidated, and final existing-schema
status. The final `evaluation.json` must keep each originating ID discoverable
in a finding description, evidence description, resolution, or dismissal
rationale. A prose report may group related findings, but it must not remove
their evidence or make an issue disappear because the aggregate score passes.

Only direct or reproducibly derived evidence can justify `verified`. Use
`dismissed-with-rationale` only with evidence that addresses the originating
claim. Editorial disagreement, an unchanged document, or a high average score
is not a disposition. If the schema cannot represent a needed explanation in a
new property, use its sanctioned evidence, resolution, dismissal rationale,
dimension rationale, or limitations fields.

Keep source fact identity as well as review finding identity. When the
technical wrapper links a fact to an issue, any retained or consolidated final
finding must keep both IDs and the source locator discoverable. The cited range
must include the implementation lines that establish the retained behavior,
not only its declaration or signature. An unverified dimension remains an
affected quality limitation. The wrapper's complete dimension list proves only
structural accounting, so do not infer factual completeness without
independently comparing the frozen source.

Repeated `1.` list markers are valid automatic Markdown numbering under
CommonMark/GFM. Retain a numbering defect only with an applicable rule ID and
configuration locator or an observed rendered ordering failure. Otherwise
record the allegation as an unverified question and exclude it from the defect
set.
