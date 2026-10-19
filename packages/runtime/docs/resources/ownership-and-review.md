---
title: "Documentation Ownership and Review for DocsFab"
description: "Know who owns DocsFab documentation decisions and how changes are reviewed."
template-source-version: "1.0.0"
---

# Documentation Ownership and Review for DocsFab

<!-- Diataxis: reference. This policy identifies ownership and review expectations for repository documentation. -->

DocsFab maintainers own the accuracy and lifecycle of in-repository product documentation. Contributors own the correctness of their proposed change and must preserve the repository's security and contract boundaries. This policy governs documentation content; it does not replace repository CODEOWNERS, GitLab approvals, or organizational CI policy.

## Ownership

| Area | Accountable owner | Review focus |
| --- | --- | --- |
| Product and architecture documentation | DocsFab maintainers | Product claims, architecture boundaries, and cross-links. |
| Security and trust documentation | DocsFab maintainers with security review when controls change | Threat-model alignment and non-overstatement of security claims. |
| Generated or versioned contracts | Owning code-area maintainer | Schema, test, and implementation agreement. |
| Governed imports and notices | DocsFab maintainers | Exact provenance, license notices, and lock-file references. |

## Review Expectations

1. Keep the page's Diataxis role clear: explanation, tutorial, how-to, or reference.
2. Link to the canonical source for a detailed contract instead of copying it into an overview.
3. Verify changed links and run `npm run check` when the documentation change affects checked repository contracts or tests.
4. Treat credentials, prompt content, raw records, patches, and host paths as private; do not add them to repository documentation.
5. Request the relevant owner review when a change makes a security, authority, licensing, or release-readiness claim.

## Review Cadence

Review documentation when its owning code or contract changes, when an issue identifies a stale claim, and before a release-readiness decision. Time-sensitive exception records name their own next-review dates; follow those records rather than inventing a global expiry.

## Related Documentation

- [Security and trust](../../../../docs/about/security.md)
- [Dependency exceptions](../reference/operations/dependency-exceptions.md)
- [Third-party notices](third-party-notices.md)
