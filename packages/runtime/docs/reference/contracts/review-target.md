/**
 * Existing-MR review target and destination-neutral result (#219 / #211).
 *
 * `comment-existing-mr` is Review-tier: one structured, redacted summary.
 * `update-existing-mr` is a separate higher-capability Contribute contract.
 * The runtime binds exact GitLab host, numeric project, MR IID, branches, and
 * head SHA. Model output cannot select the target. GitLab projection is
 * host-owned (#220).
 *
 * **Status:** Accepted with investigations #211 and #212
 * **Task:** #219 (parent epic #208)
 */

## Binding

A sealed `docsfab-review-target` carries:

- SCM provider (`gitlab`)
- GitLab host (hostname, never a tokenized URL)
- numeric project id and merge-request IID
- source and target branches
- observed head SHA
- trigger (`interactive` | `api` | `webhook`)
- authenticated request identity digest
- workflow identifier
- delivery intent (`comment-existing-mr` only)

This Review-tier target intentionally accepts `comment-existing-mr` only.
`update-existing-mr` uses separate runtime request, authority, grant, and
evaluation contracts under `src/delivery/update-existing-mr/`; this module
does not mint or intersect that higher-capability authority. Its host-side
evaluation carries a typed report locator whose digest is bound to the request
and newly reviewed head, and its injected summary projector reconciles a typed
receipt rather than issuing a raw note POST. Its fallback projector likewise
returns a typed request/state/locator/body receipt for reconciliation, behind a
journal-backed single-publisher lease. A crashed lease without a discoverable
remote receipt remains fail-closed as `in-progress`; this path does not
perform an automatic takeover. The generic delivery authority
currently reserves this intent, and the runtime delivery barrel does not
export these contracts as a fixed CLI workflow. A create-draft-MR request is
also a separate host publication action.

Durable idempotency is `host + project + MR + logical request + intent`.
Head SHA is bound on the target and result but is not part of that key, so
retries of the same logical request reconcile one summary. A successor after
drift is a new logical request.

`src/inputs/gitlab-mr-locator.ts` digests a credential-free locator
(`gitlab-mr:v1:host=…:project=…:mr=…`) for `gitlab-mr-note` records without
retaining URL text.

## Result

A schema-v1 sealed `docsfab-review-result` includes findings, checks,
unresolved questions, affected repository-relative paths, task/run identity,
the reviewed head (copied from the target), and optional patch and review
locator digests. Findings may add `origin`, `line`, `evidence`, and
`recommendation` without a new schemaVersion. Agent-origin findings require
evidence and recommendation. Optional `skippedPaths` is omitted from the
sealed body when empty. Schema v2 adds the typed quality-report projection:
decision, confidence, hard-gate failures, limitations, score and
interpretation band or an unavailable-score reason, report digest, evaluated
repository revision, and optional patch digest. The evaluated revision must
equal the reviewed MR head. Schema v2 may also carry optional
`hostedReportUrl`: an allowlisted `http(s)://<host>[:port]/reports/<run-id>/`
link composed by the operator host, never model-authored HTML. Host
comments print `report: <url>` when that field is present and otherwise
keep the report digest. Credentials, tokens, host paths, raw prompts, and
patch bodies are rejected. Other `https://` strings stay rejected. Refer to
[hosted-quality-report.md](hosted-quality-report.md) for how runtime writes
the HTML file.

## Head proof

The host re-reads MR head before mutation. This runtime contract fails
closed on host-vouched observations:

| Proof | Code |
| --- | --- |
| Unknown identity or status | `unknown-target` |
| Ambiguous observation | `ambiguous-target` |
| Moving branches or in-flight update | `moving-target` |
| Head SHA drift | `mr-head-changed` |
| Missing SHA/branches on a current proof | `incomplete-proof` |

Lookalike authorities are not trusted. Serialized targets remain inert.
