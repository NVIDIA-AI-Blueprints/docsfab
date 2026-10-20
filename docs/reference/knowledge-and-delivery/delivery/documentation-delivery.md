---
title: "Reviewed Documentation Candidate Proposals in DocsFab"
description: "Look up the trusted-host contract for proposing an independently reviewed candidate as a GitLab draft merge request. For this repository's Fern preview, follow Preview the Documentation Site."
status: draft
content.type: reference
---

Look up the trusted-host contract for proposing an independently reviewed candidate as a GitLab draft merge request. For this repository's Fern preview, follow [Preview the Documentation Site](../../../manage/preview-documentation-site.md).

## Reviewed Candidate Proposals

Before Fern delivery, a trusted DocsFab host can propose an independently
reviewed documentation candidate as a GitLab draft merge request. The host
accepts either the existing interactive authorization or an active repository
grant for the exact project. It does not derive authority from the candidate,
the worker, or a successful validation result.

The request binds the source head, candidate tree, patch digest, target paths,
target manifest, source branch, and eligibility receipt. The host creates a
deterministic commit whose only parent is the bound source head and whose tree
is the reviewed candidate tree. Before it opens the draft, it verifies those
objects from the remote branch and rechecks current branch protection.

The host creates only an absent, unprotected source branch. It can reuse that
branch or draft only when its durable journal and the current GitLab state match
the same request exactly. It never overwrites another branch. If the default
branch moves before upload, the request becomes stale. If it moves after an
accepted upload, DocsFab retains the candidate as historical evidence and does
not present it as the current proposal.

Every GitLab JSON response used by this candidate path is read as a bounded
stream with a 1,000,000-byte ceiling. Oversized, truncated, invalid UTF-8, or
misreported-length responses fail closed before their data is trusted.

An uncertain or historical result does not advance coverage. The draft retains
the composition-path limitations from the reviewed receipt, and it does not
establish technical approval, release eligibility, merge readiness, or merge
authority.

## Related Topics

- [DocsFab Implementation Status](../../status-and-configuration/implementation-status.md)
- [Delivering Results](../../../about/core-concepts/documentation-jobs.md#delivering-results)
- [Install DocsFab](../../../get-started/installation.md)

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="delivery-paths"></a>

Refer to [Preview the DocsFab Documentation Site](../../../manage/preview-documentation-site.md#delivery-paths).

<a id="evidence-sources"></a>

Refer to [Preview the DocsFab Documentation Site](../../../manage/preview-documentation-site.md#evidence-sources).

<a id="release-boundary"></a>

Refer to [Preview the DocsFab Documentation Site](../../../manage/preview-documentation-site.md#release-boundary).
