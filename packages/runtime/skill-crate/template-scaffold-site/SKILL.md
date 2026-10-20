---
name: template-scaffold-site
description: Explain and verify the prerequisites for applying an approved site scaffold plan. Use with the host's site-bootstrap operation, exact plan and reviewer proof, pinned template library, and repository checks. This guidance does not grant model write tools or replace the native executor's approval and output-scope checks.
license: Apache-2.0 AND CC-BY-4.0
---

# Scaffold an Approved Site

Apply only the exact site plan selected by the host. The native site-bootstrap
executor owns mutation, checks, and retained evidence. This skill supplies
read-only guidance; it does not authorize direct model edits.

## Required authority and evidence

- One immutable IA plan reference and its complete application bundle.
- A current signed approval from the independently configured reviewer policy.
- Matching repository revision, content digest, and index digest.
- The approved output paths and create operations, selected topics, and template
  selection digest.
- The pinned template catalog and repository-check capabilities selected by the
  host.
- A separate host authorization for this exact operation and output scope.

The bundle cannot select its own trusted reviewer, template policy, or executable.
A digest proves identity; it does not by itself grant approval or permission.

## Apply boundary

Verify that the approved plan, evaluation, navigation evidence, reviewer proof,
template selection, and current checkout agree. Preserve expiry and signature
checks. Use the existing native site-bootstrap operation; do not reproduce its
writes with generic model tools.

Create only the approved outputs. Do not overwrite existing files, follow a
symlink to another location, choose an alternate path on collision, or broaden
the documentation write scope to accommodate the scaffold. A changed source,
missing check, invalid approval, or substituted template stops before mutation.

## Result and recovery

Retain the real operation outcome and reviewable patch. Distinguish success,
refusal before mutation, and failure after partial mutation. If interrupted,
preserve the evidence needed for the host to recover; do not report completion
or silently retry another scope.

No branch publication, merge, or deployment follows from an approved scaffold.
Those actions retain their separate authorities. Do not call another skill or
ask a model to manufacture missing approval evidence.
