---
title: Verify Technical Accuracy Skill in DocsFab
description: Verify consequential claims, procedures, commands, examples, APIs, versions, and boundaries.
status: draft
---

The DocsFab `verify-technical-accuracy` skill inventories source facts,
then compares the frozen document with authoritative evidence or
observed behavior. For more information, refer to [Checking and Review
Skills in DocsFab](index.md).

## Contract at a Glance

| Field | Contract |
| --- | --- |
| Mode | Read-only; product execution requires separate authorization |
| Runtime binding | Inventory-only Pin A step `derive-source-obligations` on create and review; verification step in `review-documentation`, `create-documentation`, `update-documentation`, and `restructure-documentation` |
| Primary output | Risk-weighted claim evidence, findings, observations, and unverified remainder |
| Does not establish | Editorial quality or release readiness |

## Verification Evidence

The verifier inventories consequential claims and tests every critical claim
plus a declared risk-weighted sample. Authorized execution records exact
commands, environment, status, and observations; not run and failed are
different states.

Create and review also run this skill in inventory-only mode as Pin A step
`derive-source-obligations` before write or candidate comparison. That step
inspects approved source without treating documentation as the answer. It
returns only the host-required ledger proposal. It is not a ninth catalog
skill. The ledger remains untrusted host-sealed evidence.

Inventory-only and compare modes share the source-fact inspection method.
`write-documentation` cites that method and does not own a second copy.

Findings identify the location, claim, evidence, observation, severity,
minimum correction, confidence, and unverified remainder. Static signals,
syntax checks, and links do not prove runtime behavior.

In CREATE and REVIEW, the workflow uses this skill for an explicitly
provisional comparison and one fresh final correction. The correction reads
the source again, checks findings against the fact inventory, and accounts for
each source obligation. It can retain, refine, or reject a proposal with source
evidence. It does not repeat a false proposal to preserve coverage.

For the current canonical correction, the model returns a closed version 3
proposal. It contains the verdict, coverage, complete fact inventory, obligation
accounting, and bounded issue judgments. Each judgment contains only an issue
ID, severity, category, target location, and linked fact IDs. The proposal does
not contain separate finding, evidence, action, consequence, or impact prose.

The host validates each judgment against its fact links and the authoritative
review target paths. It then derives the existing review issue fields from the
exact fact statements, dispositions, uncertainties, source locators, and
host-bound repository revision. Fixed action templates cover omitted facts,
conflicts, unavailable policy authority, and source-observed product defects.
The host does not infer a quantity, condition, consequence, owner, approver,
authority, or product fix while deriving the result.

The final phase reads provisional evidence, so it is a correction rather than
an independent review. The separate acceptance run remains responsible for an
independent semantic judgment of the completed documentation.

Provisional output remains in the private run record. It does not supply
current findings or final quality evidence. The stored final verification
result retains its existing `review`, `coverage`, and `factInventory` fields.
Separate correction evidence retains the complete untrusted proposal, proposal
and final-result digests, source checks, source authority binding, and ledger
binding. Valid structure, deterministic derivation, and complete accounting do
not prove semantic completeness or factual correctness.

UPDATE, RESTRUCTURE, direct verification, and historical workflows without the
fixed source-obligation sequence keep the existing single-result behavior.

## Boundaries

The verifier does not perform editorial rewriting, publish, or perform SCM
changes.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/verify-technical-accuracy/SKILL.md)
- [Source-fact method](../../../../../packages/skills/verify-technical-accuracy/references/source-fact-method.md)
- [Finding categories](../../../../../packages/skills/verify-technical-accuracy/references/finding-categories.md)
- [Verification methods](../../../../../packages/skills/verify-technical-accuracy/references/verification-methods.md)
- [Comprehensive review binding](../../../../../packages/runtime/workflows/review-documentation.json)
- [Create workflow binding](../../../../../packages/runtime/workflows/create-documentation.json)
- [Update workflow binding](../../../../../packages/runtime/workflows/update-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)
