# External input manifest

DocsFab records which repository and external materials were supplied to a run
without letting the model invent source identity, version, visibility, or
disclosure authority. The v1 contracts are harness-neutral and live under
`src/inputs/`.

## Host-controlled identity

Only the host can open a registry and register inputs. Each entry binds:

- a stable host-issued `inputId`
- source kind (`direct-instruction`, `repository-document`, `slack-thread`,
  `confluence-page`, `upload`, `gitlab-issue`, `gitlab-mr-note`, or `url`)
- a safe title
- a permission-aware locator digest (never a raw tokenized URL)
- supplier identity digest
- version or timestamp binding
- optional content digest without the private body
- visibility, disclosure policy, and intended roles
- lifecycle state

Raw Slack, Confluence, upload, issue, MR note, and URL bodies stay outside the
durable manifest. Locators are digested through `digestExternalInputLocator` so
records remain reproducible without retaining private locator text.
Existing-MR review bindings digest a credential-free numeric GitLab locator
through `digestGitlabMrReviewLocator` (see
[review target](review-target.md)).

## Lifecycle states

Registration starts in one of `supplied`, `discovered`, `inaccessible`, or
`excluded`. Later host transitions may move an entry through `accessed`,
`cited`, `unused`, `changed`, `revoked`, or terminal `excluded`/`revoked`
states. The states are mutually constrained:

- inaccessible entries cannot carry a content digest or a readable locator
- excluded entries require a `forbidden` disclosure policy
- cited entries cannot use `forbidden` or `redacted` disclosure
- public visibility cannot combine with `forbidden` disclosure
- metadata-only locators cannot claim quote disclosure or store a body digest

Decoded manifests are inert. Lifecycle changes require the original private
host capability.

## Access capture

Issue #124 adds host access observations and offline fake adapters on top of
this manifest. Supplying a source does not mark it accessed. Tool-mediated
opens emit one observation bound to the registered input ID and exact step.
Access does not imply influence.

## Citation

Issue #125 adds a constrained citation capability. The model may cite only
host-registered input IDs in an allowed role. Each citation binds a step, a
structured claim digest, and optionally an access observation. Unknown,
inaccessible, revoked, stale, or disclosure-incompatible IDs produce
reviewable diagnostics instead of fabricated certainty. Reconciliation
records `accessed-and-used`, `accessed-but-unused`, `supplied-but-unused`,
and inaccessible/excluded/revoked/changed states. Citations cannot grant
tools, writes, or publication authority.

## Disclosure security

Issue #127 projects inputs onto prompt, log, run-record, patch, commit,
MR, and terminal surfaces through clamped disclosure levels:

`opaque-identity` → `safe-label` → `permission-aware-link` →
`bounded-excerpt` → `public-content`

Policy, surface, and visibility each impose a ceiling. Citation cannot raise
that ceiling. Titles, locators, and excerpts are sanitized against credential
leakage, Markdown injection, and provenance-marker spoofing before emission.

## Authenticity and persistence

Current manifests are minted only through an internal host verifier. The
verifier receives a content-free challenge over the run binding, entry digests,
and proposed manifest digest, then returns a host-owned timestamp and one
receipt identity. Receipt reuse is rejected.

Serialized manifests are deliberately inert. A strict decoder verifies the
closed schema and every canonical digest but does not grant authority.
Restoring authority requires the original private capability and a
byte-equivalent decoded artifact.

Public projections retain only digests, source kinds, permission class,
visibility, disclosure policy, intended roles, and lifecycle. They omit safe
titles, supplier identifiers, raw locators, and private source bodies.

Epic #118 publication narratives must consume
`projectExternalInputManifest` and surface-clamped
`projectExternalInputDisclosure` (directly or via
`docsfab/publication`) rather than inventing a third provenance
dialect. See [Publication provenance projectors](publication-provenance-projectors.md).

## Versioning and evaluation

Schema v1 uses identity-only migration. Unknown versions fail closed.
Historical absence is represented only by the explicit empty historical
constructor; v1 never upgrades missing evidence into authority.

The deterministic fixture is `test/fixtures/external-input-manifest-v1.json`.
Focused tests cover registration, lifecycle constraints, canonical round trips,
inert decoding and exact restoration, replay, substitution, credential
rejection, content-minimized projection, fake adapters, access ledgers,
citation reconciliation, and disclosure clamping.
