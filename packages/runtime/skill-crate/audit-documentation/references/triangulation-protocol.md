# Triangulation Protocol

Compare the focused document through applicable documentation-coverage paths;
establish their independence rather than assuming it.

## Overview

When a focused-document coverage or set-membership question cannot be answered
from the page headings alone, use the **Triangulation Protocol** to assess
scope, coverage, and documentation-set problems through multiple evidence
paths. Use triangulation for documentation coverage and gaps, not as a second
technical verifier.

Do not use this protocol to decide source-vs-claim, example validity, or
unsupported technical claims. Those remain with `verify-technical-accuracy`.
Do not use it to run native lint, link, or syntax checks. Those remain with
`lint-documentation` and the host executor.

**Evidence agreement, confidence, and conflicts**: [aggregation-confidence.md](aggregation-confidence.md)

## The Three Paths

### Path A: Focused document

**Goal**: Record what the frozen target actually covers.

**Search strategy**:
1. Inventory headings, stated purpose, in-page journeys, and explicit
   out-of-scope notes
2. Map those topics to the declared audience and requested outcomes
3. Note missing in-page orientation to sibling pages in the set

**Evidence format**: see [assets/evidence-yaml-examples.md](../assets/evidence-yaml-examples.md)

### Path B: Declared documentation set

**Goal**: Record what the frozen set inventory, navigation, and sibling pages
require of this target.

**Search strategy**:
1. Find the page in the declared set, TOC, or navigation
2. Read inbound and outbound in-set links and role statements on sibling pages
3. Record orphaned, duplicate, or mis-placed coverage relative to the set

**Evidence format**: see [assets/evidence-yaml-examples.md](../assets/evidence-yaml-examples.md)

### Path C: Requested outcomes and audiences

**Goal**: Record what the frozen job, audience, and outcomes require this page
to cover.

**Search strategy**:
1. Read the declared outcomes, audiences, and risk boundary
2. Compare required journeys against the page and the set inventory
3. Leave a required journey `not-assessed` when the set never assigned it

**Evidence format**: see [assets/evidence-yaml-examples.md](../assets/evidence-yaml-examples.md)

## Example

**Coverage question**: "Does the install page cover the recovery path the set
assigns to it?"

```yaml
Coverage: "Install page recovery path required by the set"

Path A (Focused document):
  Found: docs/install.md
  Evidence: Install steps only; no diagnose or recover section
  Conclusion: Page does not cover recovery

Path B (Documentation set):
  Found: nav.json; docs/troubleshooting.md
  Evidence: Troubleshooting index sends recovery for a failed install back to install.md
  Conclusion: Set assigns recovery coverage to the install page

Path C (Outcomes and audiences):
  Found: declared operator outcome "recover from a failed install"
  Evidence: Outcome is in scope for the frozen job
  Conclusion: Required journey is in scope; page coverage is missing

Aggregation: Document, set, and outcome agree that recovery belongs here and
is absent; this is a coverage gap, not a technical-claim verdict
```

(See [aggregation-confidence.md](aggregation-confidence.md) for authority and uncertainty rules.)

## Limitations

This protocol is **heuristic**, not deterministic:

- Depends on locating the declared set, navigation, and outcomes
- May miss sibling pages or implied journeys in a large set
- Page presence does not prove a reader can complete the journey
- Results may vary between runs

For a release-facing baseline, use documentation-set scope. Technical claim
checking stays with `verify-technical-accuracy`.
