# Bounded documentation-improvement envelope contracts

This reference defines the closed JSON envelopes for a bounded campaign. For the operator procedure, see [Bounded documentation improvement](../../prove-a-doc-change/bounded-doc-improvement.md).

## Campaign declaration

The declaration has `kind: bounded-doc-improvement-campaign` and schema version 1. `repositoryId` is a non-sensitive `namespace/project` label; `repositoryIdentitySha256` is the SHA-256 of the canonical source-checkout path. Every `gap.evidence` entry has a repository-relative path and the SHA-256 of that path's blob at `testedCommit`. The success criterion is one bounded, single-line statement, and `validationProfile` is exactly `docsfab`.

The declaration records the SHA-256 of every exact private input byte sequence and patch byte length. It can use well-formed placeholders for application, patch, and independent-review leaves before those artifacts exist, then records their exact identities during finalization. Repository, revision, gap evidence, and success criterion must not change.

## Authorization and independent review

Authorization is a `bounded-doc-improvement-authorization` value with decision `approved`, reviewer role `maintainer`, and only sorted repository-relative intended paths. `approvedOutcomeSha256` is the canonical digest of the terminal audit proposal, not the campaign goal text. Its signed `gap` projection contains the gap ID and canonical digests of the complete evidence list and success criterion; changing either invalidates the grant.

Authorization must be decided after audit completion, remain current through application, and be recorded before application finishes. It does not weaken the ordinary `update-documentation --allow-write` gate. The independent review is a `bounded-doc-improvement-independent-review` with the closed disposition `addresses-gap-without-unsupported-additions`; it binds campaign, gap, revision, and patch SHA-256 and occurs after application.

Both decisions use Ed25519 signatures and an owner-only host-trusted reviewer policy supplied with `--reviewer-policy`. The authorization and independent reviewers must be distinct trusted maintainers with cryptographically distinct Ed25519 public keys. Aliases backed by one key are one authority; an artifact cannot make itself trusted by claiming a role or embedding a key.

## Canonical digest

All three envelope values contain `digest`: the canonical SHA-256 computed by DocsFab's `canonicalDigest` helper over the complete value with `digest` omitted. This binds later reproduction to content rather than filenames or mutable run-store state.
