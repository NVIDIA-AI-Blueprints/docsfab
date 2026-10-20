---
title: Plan Documentation Skill in DocsFab
description: Produce an approval-ready documentation plan, locate pages from the NVIDIA documentation template set table of contents, and perform conditional SRD intake.
status: draft
---

The DocsFab `plan-documentation` skill resolves audience, outcomes, scope,
sources, information architecture, page or book topology, dependencies,
validation, review roles, and destinations before authoring begins. For more
information, refer to [Planning and Authoring Skills in DocsFab](index.md).

## Contract at a Glance

| Field | Contract |
| --- | --- |
| Mode | Read-only |
| Runtime binding | Planning step in `create-documentation`, `update-documentation`, and `restructure-documentation` |
| Primary output | An approval-ready, source-grounded plan with a frozen page set and source mapping |
| Stops when | A high-impact product, audience, scope, authority, placement, or destination decision is missing |

## Information Architecture

The skill overlays the NVIDIA documentation template set's table of contents onto the
target repository. The table of contents is structure guidance only. It does
not require creating every family or page. Existing folders and navigation
win. When a needed family or page is missing, the skill proposes the canonical
folder and a topic-slug filename. It does not force-create inapplicable pages,
scaffold files, or invent a parallel site tree.

Each planned page covers one topic (one task or one concept) and one Diataxis
content type: concept, how-to, tutorial, or reference. When a page mixes
those, or exceeds 500 lines during creation or restructuring, the skill plans
modular pages and places each topic in its family. During an update, it keeps
the bound operation and records a structural recommendation separately. If the
requested correction needs a broader scope, it returns `needs-input` before
writing instead of silently planning a split.

After placement is resolved, the skill freezes the page set for the selected
workflow mode: new pages or sections for create, the smallest existing change
for update, and a complete source-to-target map for restructure.

## Source and SRD Intake

The skill inspects repository evidence before asking questions. An SRD is
conditional source evidence, not a universal gate. When required, the skill
checks a supplied SRD without rewriting it or drafts a generic requirements
structure from approved evidence and a bounded interview. Unknown non-blocking
facts remain `TBD`; missing high-impact decisions stop approval.

## Output and Boundaries

The result includes the document set, purpose and source map for each page,
information architecture, checks, review roles, unresolved questions, and
approved destinations. Planning does not authorize final drafting,
publication, or SCM changes.

For a runtime planning step, return one JSON object containing `summary` and a
semantic `planBinding` with `mode`, `pages`, and `sourceBindings`. The runtime
host validates this page/source map and adds its kind, schema version, and
digest before passing the binding to the writer. When a required fact is
unresolved, return `outcome: "needs-input"` with a bounded reason instead of
fabricating a plan or digest.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/plan-documentation/SKILL.md)
- [Canonical information architecture](../../../../../packages/skills/plan-documentation/references/canonical-ia.md)
- [Page-set freeze](../../../../../packages/skills/plan-documentation/references/page-set.md)
- [Minimal interview](../../../../../packages/skills/plan-documentation/references/minimal-interview.md)
- [Requirements document format](../../../../../packages/quality/formats/requirements-document-format.md)
- [Create workflow binding](../../../../../packages/runtime/workflows/create-documentation.json)
- [Update workflow binding](../../../../../packages/runtime/workflows/update-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)
