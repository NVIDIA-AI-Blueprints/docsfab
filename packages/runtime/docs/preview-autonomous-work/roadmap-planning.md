# Read-only roadmap planning

`docsfab roadmap-plan` turns an authenticated release or documentation-health
analysis into one reviewable roadmap ledger and a content-free mutation-plan v2.
It never creates an authorization and its GitLab edge exposes only `GET` issue
observation. The command does not change the source checkout, branch, merge
requests, issues, labels, milestones, or comments.

## Commands

Replace `BASE_TAG` and `TARGET_TAG` with release tags from the target repository.
These tags identify that repository's releases, not the DocsFab version.

```sh
docsfab roadmap-plan --mode release --since BASE_TAG \
  --release-ref TARGET_TAG --input /private/release-roadmap-input.json --json

docsfab roadmap-plan --mode health --scope docs/api \
  --input /private/doc-audit-roadmap-input.json --json

docsfab roadmap-plan --sweep /private/roadmap-ledger.json \
  --input /private/supplemental-sweep-input.json --json
```

The input is a closed `docsfab-roadmap-planning-input` schema-v1 object. Release
input must bind the exact `release-docs-epic` contract digest and a
content-addressed `git-release-boundary` authority. The command independently
enumerates additions, modifications, deletions, and renames for the immutable
from/to revisions, binds both tree digests and the raw name-status digest, and
requires every actual change to be accounted exactly once. Health input embeds
an `authenticated-doc-audit-package`: its complete finding graph is
content-addressed and bound to the exact project, repository revision, content
digest, and optional scope. Candidate, unit, draft, evidence-path, and evidence-
digest substitutions fail closed.

Use `--limit` to cap high-confidence new proposals. Low-confidence or
conflicting evidence produces a bounded investigation draft; it never invents
implementation scope. Every actionable draft contains acceptance criteria,
verification, evidence paths, and either enough context to execute alone or an
explicit `requiredParentContext` declaration.

## Reconciliation and output

Planning always performs deterministic fingerprint/material reconciliation
before it considers governed semantic overlap evidence. Existing work is
linked, extended, or superseded. Rankings record impact, evidence confidence,
urgency, dependency importance, scope, and expected verification cost. Harmless
input ordering does not change finding fingerprints or operation keys.

The JSON output contains:

- a revision-, project-, and tracker-bound roadmap ledger;
- ranked, reviewable drafts and concise ranking reasons;
- a schema-v2 content-free mutation plan, or `null` when no external operation
  is proposed;
- `readOnly: true`, `authorization: null`, and the exact deterministic-before-
  semantic reconciliation order.

The artifact remains useful as a dry run. Before any later execution, call the
planning freshness validator with the current repository and sanitized tracker
observations; repository or same-timestamp tracker identity drift invalidates
it. A later writer must separately obtain v2 authorization. This command cannot
produce one.

## GitLab observation boundary

For GitLab projects, set `GITLAB_TOKEN` or `PRIVATE_TOKEN` in the host
environment when authentication is required. Tokens are sent only as the
`PRIVATE-TOKEN` header to a credential-free HTTPS API URL and are never placed
in prompts or output. The adapter follows bounded pagination and retains only
issue IID, state, update time, an identity digest, and explicit
`docsfab-fingerprint`/`docsfab-material` digests. Raw titles, descriptions,
labels, milestones, credentials, and host paths are not persisted.

The project identity is strict-decoded and matched both to the source package
and to host-owned configuration before a reader is constructed. Production
uses `DOCSFAB_ROADMAP_GITLAB_HOST`, `DOCSFAB_ROADMAP_GITLAB_FULL_PATH`, and
`DOCSFAB_ROADMAP_GITLAB_PROJECT_ID`; planning input never selects a credential
destination. A configured `--gitlab-url`
must be the exact canonical `https://<trusted-host>/` origin: alternate hosts,
ports, paths, user information, queries, fragments, and redirects are rejected
before a token-bearing request can occur. The reader remains bound to that
project identity for its lifetime.

The host also supplies `DOCSFAB_ROADMAP_SOURCE_SHA256`, the exact digest of the
immutable reviewed release/audit input. An exact match yields an opaque,
non-serializable source capability. Planning, serialization, freshness checks,
and later artifact validation require that same capability, which seals the
first artifact digest and contributes a unique capability-lineage identifier to
the artifact. A separately issued capability for the same source cannot
validate it. Consequently, a self-consistent attacker rewrite of the
package, candidate identity, draft text, public mutation-plan fields, and all
public digests still fails against the original host authority.
