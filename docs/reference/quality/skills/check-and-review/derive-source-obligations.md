---
title: Derive Source Obligations
description: Derive a bounded atomic source-obligation ledger from approved repository evidence.
status: draft
content.type: reference
---

`derive-source-obligations` proposes reader-relevant source obligations from
the frozen source before a writer or technical reviewer treats documentation
as an answer.

## Contract at a Glance

| Field | Contract |
| --- | --- |
| Mode | Read-only |
| Runtime binding | Step 2, role `source-obligation-analyst`, in `create-documentation` and `review-documentation` |
| Primary output | Bounded ledger proposal with completeness, six dimensions, and limitations |
| Does not establish | Technical truth, documentation quality, write authority, or factual completeness |

The `update-documentation` and `restructure-documentation` workflows do not
schedule this skill.

## Ledger Derivation

The skill freezes the repository revision, scope, documentation targets,
host-granted read scope, and reader outcome. It inspects admitted source
within that read scope. It does not treat a supplied path list as the
complete readable evidence.

For CREATE, it obeys the validated plan's page and source map. For REVIEW, it
inspects relevant implementation, declarations, configuration, and tests
through the host's confined read tools. Neither mode can add write, tool,
publication, or out-of-workspace authority.

Each obligation carries one ID, one dimension, complete source locators, one
atomic statement, one evidence class (`source-observation` or
`source-inference`), and explicit uncertainty. Completeness remains
`bounded-not-proven`. The host adds revision, scope, source-evidence
identity, kind, schema version, and digest.

The six dimensions are `input-representations`,
`defaults-and-overrides`, `mutable-state`, `destination-and-trust`,
`error-status-retry`, and `environment-prerequisite`.

## Boundaries

The ledger is untrusted model evidence. The skill does not inspect or edit a
documentation candidate, assign dispositions, draft findings, grant
authority, or claim that six populated dimensions prove every material fact.

## Authoritative Sources

- [Inventory-only verification skill contract](../../../../../packages/skills/verify-technical-accuracy/SKILL.md)
- [Create workflow binding](../../../../../packages/runtime/workflows/create-documentation.json)
- [Comprehensive review binding](../../../../../packages/runtime/workflows/review-documentation.json)
