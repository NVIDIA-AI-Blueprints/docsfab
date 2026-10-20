---
name: audit-documentation
description: Audit a focused Markdown target or a documentation set against repository evidence without editing files. Use focused-document scope for scope, coverage, and documentation-set problems. Source-vs-claim, example validity, and unsupported technical claims stay with verify-technical-accuracy; native checks stay with lint-documentation and the host executor. Use documentation-set scope for a frozen multi-lens inventory, coverage matrix, and evidence-backed baseline that does not claim release readiness.
license: Apache-2.0 AND CC-BY-4.0
allowed-tools: Bash(python:*) Bash(git:*) Read
metadata:
  author: "Lawrence Lane <llane@nvidia.com>"
  version: "9.1.0-docsfab.1"
---

# Audit Documentation

Audit the runtime-selected documentation against the selected repository
revision. This skill returns findings and evidence. It does not edit files,
schedule another skill, or decide whether a later write step may run.

## Required inputs

- The audit scope: `focused-document` or `documentation-set`.
- The runtime-selected repository and immutable revision.
- The in-scope Markdown file, directory, or declared documentation set.
- Applicable repository instructions, approved product evidence, quality
  profile, style guide, audiences, outcomes, and risk boundaries.
- The deterministic commands and read-only tools granted by DocsFab.
- For documentation-set scope, the audit budget, evidence location, retention
  boundary, and available provider contexts.

Return `insufficient-evidence` for a required dimension when the target,
audience, product evidence, or evaluation context is missing. Do not infer
those inputs from polished prose.

## Audit

1. Freeze the audit scope, target paths, repository SHA, product-model
   revision when present, profile, audiences, outcomes, risks, evidence
   boundary, providers, and tools.
   When source-reading tools are granted, read
   [references/documentation-sources.md](references/documentation-sources.md)
   and inspect the bound change manifest before declaring PR scope unavailable.
2. For `focused-document` scope:
   - Compare the frozen target to the declared job, audience, outcomes, and
     documentation set. Record scope defects: undeclared paths, missing in-set
     dependencies, pages that cannot serve the requested outcome, and content
     that belongs on a different page.
   - Assess documentation coverage and documentation-set problems for that
     target: missing topics or journeys the set requires, broken in-set
     orientation or findability, orphaned or duplicate pages, and gaps between
     the page and the declared set inventory.
   - Read
     [references/triangulation-protocol.md](references/triangulation-protocol.md)
     to compare the focused document, the declared documentation set, and the
     requested reader outcomes. Use triangulation for documentation coverage
     and gaps, not as a second technical verifier.
   - Reconcile conflicting coverage evidence using
     [references/aggregation-confidence.md](references/aggregation-confidence.md).
     Preserve unknown and bounded-not-found results.
   - Do not treat source-vs-claim, example validity, or unsupported technical
     claims as this scope's primary findings; those remain with
     `verify-technical-accuracy`. If they appear, record them as out-of-scope
     notes without converting them into audit defects.
   - Do not run native lint, link, syntax, or formatting checks as this
     scope's job; those remain with `lint-documentation` and the host
     executor. Record a supplied host receipt only as coverage context. Do
     not look for an upstream plugin runtime or install one.
3. For `documentation-set` scope:
   - Read [references/lens-roster.md](references/lens-roster.md). Build a
     coverage matrix that maps every required quality dimension and constraint
     to a method, provider context, target coverage, and evidence class. Leave
     uncovered rows `not-assessed`.
   - Collect authorized deterministic source signals and inspect the frozen
     set for technical and product-model fidelity, editorial quality,
     information architecture and findability, task and recovery support,
     audience-evidence coverage, and applicable constraints.
   - Record authorship, prior exposure, provider, context, evidence strength,
     severity, confidence, affected scope, and an acceptance condition for
     every finding. Preserve human and agent outcomes separately.
   - Produce the inventory and baseline evidence for later workflow steps.
     Do not invoke technical verification, peer review, audience testing, or
     quality evaluation; the runtime schedules those skills when required.
4. Reconcile disagreements against authoritative evidence without averaging
   away a hard failure, audience-specific failure, or missing required
   evidence. Deduplicate only equivalent findings.
5. Treat repeated `1.` markers as valid automatic Markdown numbering. Report a
   numbering defect only when an applicable repository rule or linter
   configuration supplies a stable rule ID and applies to the frozen path, or
   when observed rendered output has the ordering defect. Otherwise retain the
   concern as an unverified question and do not count it as a defect.
6. Read [references/output-contract.md](references/output-contract.md) and
   return the output for the selected scope with exact paths, evidence,
   severity, confidence, checks not run, limitations, and verification needs.

## Decision rules

- Apply applicable hard-gate precedence before a summary judgment.
- Return `fail` for an applicable hard failure even when other dimensions are
  strong.
- Return `insufficient-evidence` when required evidence is absent.
- Preserve `not-assessed`, `not-applicable`, and `insufficient-evidence` as
  distinct states.
- For `focused-document` scope, primary findings are scope defects, coverage
  gaps, and documentation-set problems. Do not classify source-vs-claim,
  example validity, or unsupported technical claims as primary findings.
- Do not treat native lint, link, syntax, or formatting results as the
  focused-document verdict.
- Do not issue a release-readiness verdict from a source-only audit.
- Close a finding only with independent verification or an authorized
  dismissal with retained rationale.

## Boundaries

- Remain read-only even when the runtime schedules a later write step.
- Do not invoke or route to another skill; runtime owns composition.
- Do not execute documented product procedures, use credentials, access an
  undeclared network resource, or mutate external state.
- Do not infer release status, support commitments, defaults, security claims,
  or product intent from plausibility.
- Do not edit, rewrite, publish, commit, push, merge, or modify tracker state.
- Stop the affected path and record the limitation when the frozen target
  changes, evidence leaks into a clean context, required authority is missing,
  or two attempts fail because of the same evaluator or environment defect.
