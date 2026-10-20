---
name: converge-documentation
description: Detect and repair drift among source threads, immutable product-reference-model versions, generated documentation, readiness records, and quality evidence. Use after new repository behavior, interviews, documents, decisions, model reconciliation, or documentation changes, and before claiming that DocsFab artifacts are current.
license: Apache-2.0 AND CC-BY-4.0
---

# Converge Documentation

Keep the evidence-to-model-to-documentation chain current without granting an
automation process authority to invent decisions, merge, publish, deploy, or
approve a release.

Read [references/convergence-contract.md](references/convergence-contract.md)
before running a cycle.

For a registered source case that changes one existing claim's statement and
scope, read [Native Product Feedback Materialization](references/product-feedback-materialization.md).
Use its substantive paragraph replacement and exact byte reproduction path.
Appending a provenance block does not complete a source-case projection.

Install the checker dependency into the active Python environment before the
first run:

```bash
python3 -m pip install -r packages/knowledge/skills/converge-documentation/requirements.txt
```

## Run the Cycle

1. Run the freshness checker in advisory mode.

   ```bash
   python3 packages/knowledge/skills/converge-documentation/scripts/check_freshness.py check
   ```

2. Inspect every reported issue. Treat malformed evidence as an error. Do not
   continue past it. An unresolvable `git_revision` with a valid
   `content_sha256` and `git_tree` is advisory `stale`
   (`receipt-revision-unresolvable`), not an error.

3. Assess changed repository behavior with `assess-product-repository` and
   register every selected new document, interview, decision, repository
   snapshot, or correction with `register-source-thread`.

4. Compare registered item IDs with all immutable model versions. Classify
   every selected item as included, superseded, excluded with rationale, or
   explicitly pending in the merge boundary's structured source-item records.
   Comments, prose mentions, and evidence quotations do not count. Silent
   omission blocks freshness. Each included record must bind the exact thread
   head at the merge timestamp and either one item-level representation or one
   collection member with its own integrity value.

5. Run `synthesize-source-threads`. Resolve version and scope differences only
   when pinned evidence establishes the resolution. Preserve semantic or
   accountable-intent conflicts and ask whether the user wants to adjudicate
   them one at a time.

6. After semantic adjudication, issue a new immutable model version. Do not
   edit an earlier version. Issuing a model does not by itself close any
   governed visual target.

7. Apply the governed visual completion gate to each diagram, architecture
   view, state machine, timeline, or equivalent rendered target in the newly
   issued model. A target is not closed, current, or of record until its exact
   post-adjudication representation exists directly in the new immutable
   Product Reference Model with a stable ID, content checksum, exact source and
   decision references, and verified decision coverage. Semantics-only closure
   remains an open or deferred `representation-conflict` that blocks the visual
   target. Indirect links, summaries, prose, and decision lists do not satisfy
   this gate. Preserve source, derived, superseded, rejected, and current
   distinctions. An intentionally omitted visual remains open or deferred.

   Run the named closure validator directly when preparing a model package.
   `check_freshness.py` also invokes it for v0.29 and later model versions.

   ```bash
   python3 packages/knowledge/skills/synthesize-source-threads/scripts/validate_visual_closure.py \
     <model-version>/model.md \
     <model-version>/inconsistency-report.md \
     <model-version>/merge-receipt.md \
     .docsfab/reference-model/source-threads \
     .docsfab/reference-model/shared/DOCSFAB-PRODUCT
   ```

8. Regenerate every affected page. Rescan the configured information
   architecture and generate newly ready targets. Keep blocked targets
   explicit instead of filling gaps with plausible prose.

9. Run deterministic checks and the minimum non-author adversarial review. An
   agent author uses a clean subagent. A human author uses another human or a
   clean agent that did not participate in authorship. Retain the PASS report
   under `.docsfab/reference-model/assessments/`; it must name the exact
   reviewed commit and tree. Use one top-level `## Verdict`, one `**PASS**`,
   and two distinct top-level bullet items whose first direct paragraphs
   declare `Reviewed target` and `Reviewed target tree`, respectively.
   Continuation paragraphs and illustrative metadata in code, quoted, or
   nested blocks do not count.

10. Create a machine-readable freshness snapshot after the watched repository
   inputs, model, and documentation reach their reviewed state.

   ```bash
   python3 packages/knowledge/skills/converge-documentation/scripts/check_freshness.py snapshot \
     --check fern-broken-links="fern docs broken-links" \
     --check knowledge-tests="npm --prefix packages/knowledge test" \
     --readiness 'current-doc-set|partial|documentation-owner|human outcomes pending' \
     --blocked-target 'public-release|release-owner|no approved release record' \
     --known-gap "Representative human outcome evidence is pending." \
     --review-evidence ".docsfab/reference-model/assessments/<review>.md" \
     --reviewed-commit "<exact reviewed commit>" \
     --reviewed-tree "<exact reviewed tree>"
   ```

   Commit the reviewed product/model/documentation boundary first. Run the
   clean review against that commit, then commit only its retained report.
   The packaged default boundary watches both `.gitlab-ci.yml` and
   `.gitlab/ci/knowledge.yml`; a change to freshness admission or execution
   must invalidate the receipt.
   Snapshot creation rejects any other post-review finalization path. It also
   rejects dirty watched bytes, a missing revision, a revision/tree mismatch,
   a nonexistent review, or a report that does not name the supplied target.

11. Rerun `check`. Report `fresh`, `stale`, or `blocked`, the exact evidence
    boundary, and every remaining blocked target.

The named validator checks the retained closure manifest, exact fenced bytes
and checksum, real model claim IDs, exact source and decision sets, lifecycle
state, bidirectional representation conflicts, complete coverage mapping, and
the machine-readable section 14 receipt. It rejects malformed, duplicate, and
undeclared visual blocks and runs the fail-closed governed-flowchart Mermaid
syntax gate. It does not prove that a named node or edge semantically encodes
the accepted decision. Keep the substantive non-author review; a policy-text
test or structural validator cannot replace it.

## Use Strict Mode Deliberately

The check defaults to advisory status so the team can validate path and
event triggers before treating every change as a release gate. Use strict mode
when a workflow explicitly requires currency:

```bash
python3 packages/knowledge/skills/converge-documentation/scripts/check_freshness.py check --strict
```

Strict mode exits nonzero for `stale` or `blocked`. Both modes exit with an
error for malformed evidence. An unresolvable recorded revision is `stale`,
not an error. When `--output` is set, the checker writes a JSON report for
fresh, stale, blocked, and error results. Report paths must be under
`.docsfab/reports/`; alternate receipt paths must be under
`.docsfab/reference-model/receipts/`.

Merge-request, default-branch, and scheduled GitLab pipelines run the advisory
check for every watched knowledge, model, documentation, planning, governance,
deployment, and repository entry point. The retained JSON report is the
machine-readable work queue for the next agentic cycle. CI detects and records
drift; it does not rewrite canonical source threads, issue a model version, or
claim that a non-author review passed.

A snapshot can preserve an incomplete gate instead of inventing a pass:

```bash
python3 packages/knowledge/skills/converge-documentation/scripts/check_freshness.py snapshot \
  --check tests=pending="test environment unavailable" \
  --review-status pending \
  --review-evidence "review requested; no result yet"
```

## Preserve Authority Boundaries

- Do not resolve semantic conflicts by majority, recency, implementation
  precedence, or agent confidence.
- Do not treat a generated page as canonical product truth. The versioned
  product reference model remains canonical.
- Do not treat a passing freshness check as release, security, accessibility,
  or representative-user evidence.
- Do not let the checker modify source threads, model versions, documentation,
  merge requests, or publication state. It detects and records; the agentic
  workflow performs reviewed changes.
