# Audit Output Contract

## Shared findings

For either scope, produce `audit-report.md` with:

- the audit scope, frozen repository SHA, target paths, product-model revision,
  profile, audiences, outcomes, risks, tools, and known limitations;
- for documentation-set scope, every deterministic check attempted, its
  status, relevant output, produced artifacts, and checks not run; for
  focused-document scope, supplied host receipts only as coverage context;
- findings ordered by severity, with exact evidence, confidence, affected
  scope, and a verifiable acceptance condition;
- disagreements, adjudications, insufficient-evidence states, and unresolved
  questions; and
- prioritized remediation and independent verification needs.

Lead with consequential findings rather than readability averages. Include a
summary measure only when its numerator, denominator, method, population, and
limitations remain visible. A source-only audit does not grant release
approval.

A style finding must name the applicable rule ID and configuration or cite an
observed rendered failure. Repeated `1.` markers are valid automatic Markdown
numbering under CommonMark/GFM. Without a contrary applicable rule or a
rendered ordering defect, preserve the concern only as an unverified question.

## Focused-document output

Use [the audit report template](../assets/audit-report-template.md). Bind every
finding to the selected file or directory and the immutable repository
revision. Primary findings are scope defects, coverage gaps, and
documentation-set problems. Do not report source-vs-claim, example validity,
or unsupported technical claims as primary findings. Preserve unknown,
uncertain, bounded-not-found, `not-assessed`, and checks-not-run results
rather than converting them to passes.

## Documentation-set output

Use the configured evidence location. The recommended layout is:

```text
<audit-id>/
├── manifest.md
├── deterministic/
│   └── doc-quality-signals.json
├── reviews/
│   ├── technical.md
│   ├── product-model.md
│   ├── editorial.md
│   ├── information-architecture.md
│   └── constraints.md
├── journeys/
│   ├── task-and-recovery.md
│   ├── audience-human.md
│   └── audience-agent.md
├── evaluation.json
├── assurance-system.json
└── audit-report.md
```

Omit artifacts that are not applicable, but name the omission and reason in
`manifest.md` and `audit-report.md`. Report human and agent outcomes separately.
Treat `assurance-system.json` as a separate process result, not another layer
score. Only `evaluation.json` uses the existing layered-evaluation schema and
validator. Other files are supporting evidence with declared provenance; their
presence does not prove completeness, independence, target binding, or release
readiness.

## Evidence handling

Keep raw recordings, private telemetry, credentials, and proprietary logs
outside the report. Reference them only through approved locators. Never copy
secrets or unnecessary personal data into repository artifacts. Use
pseudonymous human participant IDs and preserve the declared agent model,
harness, instructions, retrieval, tools, and run configuration when available.
