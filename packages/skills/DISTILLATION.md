# Upstream Skill Distillation

This pass compares DocsFab main `90ecc5f4` with
the internal upstream skill collection at commit `c2ae4ef`.
The original import remains recorded in `../quality/SOURCE_SNAPSHOT.yaml`.
The resulting catalog has eight skills and four runtime workflows.
`write-documentation` absorbs focused polish; the separate polish skill is removed.
`derive-source-obligations` is a folded DocsFab-local phase of
`verify-technical-accuracy`, not a kept imported method or Pin B identity.

## Method Ownership

Upstream names below refer to `skills/steps/`, except the platform context
analyzer. DocsFab adapts methods rather than importing upstream orchestration.

| DocsFab skill | Upstream methods | Retained or adapted behavior |
| --- | --- | --- |
| plan-documentation | doc-context-analyzer, doc-audience-personas, overview/architecture/features/ecosystem templates, doc-modularize-content | Collect sources first; choose page-specific research questions; preserve the selected operation and repository IA. |
| write-documentation | doc-draft, page templates, doc-polish, doc-reflexion, release-notes-draft | Own focused polish and planned authoring; ground examples, keep the first useful path visible, make proportional corrections, preserve reader-facing output. |
| audit-documentation | doc-audit, doc-audit-deep, doc-health | Bounded inventory and evidence triangulation; actual check receipts replace plugin-runtime assumptions. |
| lint-documentation | doc-structural-lint, doc-md-syntax, doc-rst-syntax, doc-frontmatter, doc-line-length, doc-style-guide | Existing native check selection and execution evidence; no copied installer or universal renderer rules. |
| verify-technical-accuracy | doc-code-example-audit, doc-drift, doc-audit-deep, doc-verify | Existing source-first behavior inventory plus concrete example, interface-drift, and correction checks. Inventory-only source-fact discovery is a DocsFab-local Pin A phase, not a distilled imported method. |
| review-documentation | doc-editorialize, novice/pragmatist/expert/skeptic lenses, doc-self-review, doc-review-deep | Concrete reader questions, verified findings, and adjacent-defect checks without persona fan-out. |
| test-audience-understanding | Audience and task-testing intent | Keep DocsFab's existing clean-participant, frozen-oracle, and separate human/agent evidence contract. |
| evaluate-document-quality | doc-scorecard, doc-confidence-scoring, deep-review synthesis | Keep the existing layered policy and finding retention; evidence agreement is not a calibrated probability. |

Release-specific source and disclosure questions apply only to release-note
work. They do not grant publication, security-disclosure, or tracker authority.
The evaluator and audience contracts are retained, not replaced by this pass.

## Deliberate Exclusions

Do not import skill-router or registry installation, agent-memory state, Jira or
spreadsheet reporting, mandatory persona swarms, automatic commits, publication,
fixed Sphinx/Fern migration machinery, or another overall scoring formula.
Do not copy exact-source-snippet-only drafting rules, source-age-as-staleness
heuristics, confidence percentages based on agreement counts, or implementation
as unconditional authority over an approved public contract.

## Behavior Cases

These are qualification cases, not claims that model runs have passed.
Exercise the same task through live-agent and `docsfab run` when qualification
resumes. Retain artifacts, finding IDs, changed paths, tool calls, and duration.

| Workflow | Cases | Required observation |
| --- | --- | --- |
| Create | Quickstart from source; architecture page; missing material evidence | Collect first, useful page purpose, complete grounded examples, explicit needs-input without invented behavior. |
| Update | Changed default; focused polish; no-change; long mixed page; release note | Minimal bound patch, no unsolicited split, retained content and qualifications, evidence-backed correction. |
| Review | One page; conflicting related pages; mixed types; bounded corpus; missing execution/audience evidence | Scope and findings retained, applicable methods, no fabricated command or participant result. |
| Restructure | Split; merge; move; shared include; existing anchors | All preservation obligations checked at required entry points; no stranded content or silent scope expansion. |

Check a correction for both its originating defect and affected neighboring
content. Static packaging and schema checks do not establish model quality or
end-to-end workflow success. Runtime finalization defects remain separate work.
