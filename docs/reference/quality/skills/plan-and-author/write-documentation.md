---
title: Write Documentation Skill in DocsFab
description: Create or edit documentation, including focused polish, within approved scope.
status: draft
---

`write-documentation` is the focused DocsFab authoring skill shared by the
runtime workflows. The runtime selects create, update, revision, or
restructure mode and supplies the approved plan, repository, revision, and
write authorization. For more information, refer to [Planning and Authoring
Skills in DocsFab](index.md).

## Focused Edits

For a request such as "tighten this paragraph" or "make these instructions easier
to follow," the live agent can use `write-documentation` directly. The requested
target and correction supply the brief. The skill preserves technical meaning,
follows repository conventions, and checks the affected passages. It requires
write authorization but no separate planning step, typed plan binding, SRD, or
HTML artifacts. It reports changes and validation limits; independent review
remains a separate responsibility.

The standalone `polish-documentation` skill has been removed. Use
`write-documentation` for both focused polish and broader authoring.

## Runtime Bindings

| Workflow | Skill mode | Mutation scope |
| --- | --- | --- |
| `create-documentation` | Create | The requested new page or documentation set. |
| `update-documentation` | Update | The smallest approved change-scoped documentation set. |
| `restructure-documentation` | Restructure | The mapped documentation set, including supported routes, anchors, references, and navigation. |

The skill also defines revision mode for an approved bounded revision. The
current catalog manifests expose create, update, and restructure as the
operator workflows.

## Output Contract

The skill records sources, changed paths, assumptions, unresolved questions,
compatibility actions, and claims that need verification. It stops after the
bounded mutation. It does not plan, review, score, expand the approved scope,
publish, or perform SCM changes.

## Source-Fact Method

`write-documentation` does not own source-fact discovery. It cites the method
owned by `verify-technical-accuracy`, treats a host-sealed ledger as untrusted
evidence, re-reads cited spans, and does not add a writer-owned inventory
artifact.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/write-documentation/SKILL.md)
- [Source-fact method](../../../../../packages/skills/verify-technical-accuracy/references/source-fact-method.md)
- [Content-map contract](../../../../../packages/skills/write-documentation/references/content-map.md)
- [Output contract](../../../../../packages/skills/write-documentation/references/output-contract.md)
- [Create workflow binding](../../../../../packages/runtime/workflows/create-documentation.json)
- [Update workflow binding](../../../../../packages/runtime/workflows/update-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)
