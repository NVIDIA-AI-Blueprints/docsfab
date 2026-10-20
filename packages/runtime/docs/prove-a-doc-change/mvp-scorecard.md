# Revision-bound MVP scorecard

The MVP scorecard is a deterministic decision artifact built from five private
readiness records on one immutable repository revision and model profile. It
does not treat a structural PASS, a successful provider connection, or a merged
implementation as readiness evidence by itself.

The authoritative committed artifact is `scorecard.json`; `scorecard.md` is
rendered only from that JSON contract. Raw records, repository paths,
instructions, summaries, model transcripts, endpoint URLs, credentials, judge
rationale, and patch paths never enter either artifact.

## Private inputs

The command reads three existing owner-only directories:

- `--state-dir` contains exactly five immediate `0600` readiness run records;
- `--acceptance-dir` contains the successful live #34 `manifest.json`; and
- `--campaign-dir` contains a `0600` `campaign.json` and, only when semantic
  grading was exercised, a `0600` `judge-result.json` bound to all five runs.

Each directory must be owned by the current user with mode `0700`. DocsFab pins
its device, inode, owner, and mode, and separately pins the selected directory's
parent identity. It opens every leaf without following links, requires a
single-link regular file, bounds reads, and revalidates the file, path,
directory, and parent identities after reading and again before publication.
Errors contain neither paths nor record content.

Every current provider attempt records a credential-free profile projection.
It includes the current/stale/unknown status, configured and effective limits,
pricing-known status, approved-source digest and dates, and a digest over the
complete safe profile projection. The API key and endpoint URL are excluded.
The scorecard requires the same profile digest on every successful or failed
provider attempt and requires the #34 acceptance manifest to independently
bind that exact provider, model, and profile digest. A manifest that records
check-phase `checkLimitations` is valid only when its excluded test files are
exactly the ones its own recorded sandbox measurements select. Records and
manifests created before this evidence existed are not valid campaign inputs.

## Campaign declaration

`campaign.json` predeclares five numbered, independent slots. The file name,
safe run ID, and exact byte digest must all match the corresponding private
record. Duplicate IDs, files, bytes, digests, or slots and conflicting
revisions, models, or profile snapshots fail closed.

```json
{
  "schemaVersion": 1,
  "campaignId": "mvp-stabilization-01",
  "evaluatedAt": "2026-08-04T12:00:00.000Z",
  "testedCommit": "0000000000000000000000000000000000000000",
  "records": [
    { "slot": 1, "file": "run-1.json", "id": "run-1", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
    { "slot": 2, "file": "run-2.json", "id": "run-2", "sha256": "1111111111111111111111111111111111111111111111111111111111111111" },
    { "slot": 3, "file": "run-3.json", "id": "run-3", "sha256": "2222222222222222222222222222222222222222222222222222222222222222" },
    { "slot": 4, "file": "run-4.json", "id": "run-4", "sha256": "3333333333333333333333333333333333333333333333333333333333333333" },
    { "slot": 5, "file": "run-5.json", "id": "run-5", "sha256": "4444444444444444444444444444444444444444444444444444444444444444" }
  ],
  "judge": {
    "status": "skipped",
    "owner": "docsfab-maintainers",
    "issue": 5,
    "reason": "judge-destination-not-approved",
    "reviewOn": "2026-08-17"
  },
  "remainingWork": [
    { "issue": 28, "scope": "issue-28-dogfood", "owner": "docsfab-maintainers", "reason": "product-validation" },
    { "issue": 7, "scope": "shared-service", "owner": "docsfab-maintainers", "reason": "external-governance" }
  ]
}
```

Judge evidence is advisory. A skipped, disagreeing, or errored judge can only
lower the decision; it can never replace structural evidence or improve a
deterministic result. The successful #34 acceptance manifest proves the
approved judge destination and model identity. A non-skipped declaration must
then exactly match a separate `judge-result.json` whose tested commit,
structural fixture, campaign ID, and five `{id, sha256}` record bindings are
exact. The judge model must match the #34-approved identity. Judge rationale
remains private and is never published.

### Exercise the five-record judge

Semantic grading is a separate, explicit operation. Begin with an owner-only
campaign directory containing only a declaration whose judge status is
`skipped`. The #34 acceptance directory must contain both its successful live
`manifest.json` and its two-record `judge-result.json`.

```bash
DOCSFAB_CAMPAIGN_JUDGE=true JUDGE_ENABLED=true npm run judge:campaign -- \
  --state-dir /operator/private/five-runs \
  --acceptance-dir /operator/private/acceptance-evidence \
  --campaign-dir /operator/private/scorecard-campaign \
  --judge \
  --approve-judge-url "$JUDGE_BASE_URL"
```

The command requires the explicit environment gate and `--judge`, and the
approved HTTPS URL must exactly match the separately configured judge
destination. It validates the five declared record bytes and the #34-approved
judge provider/model before grading. Structural failure makes zero judge calls
and creates no artifact. Otherwise it creates `judge-result.json` exclusively
with mode `0600`; it never overwrites an existing result. The file contains
only the campaign identity, five record IDs and digests, fixture and structural
disposition, rubric, judge model identity, status, and score when applicable.
Rationale, endpoint URLs, paths, prompts, transcripts, and record content are
omitted.

The #34 `judge-result.json` is independently decoded as its exact two-record
schema and must be canonically identical to the judge evidence embedded in the
acceptance manifest (apart from the manifest-only file name and digest). After
the five-record result is exclusively opened, DocsFab retains its descriptor,
rechecks every input byte and the published result, and only then closes it. A
late input or output substitution truncates and invalidates the retained result
instead of leaving usable evidence.

A captured `passed`, `disagreed`, or `error` judge disposition returns success
because deterministic structure remains authoritative; the downstream
scorecard still reports the semantic status and may lower readiness. Only a
structural failure returns nonzero, records an explicit skipped reason, and
creates no judge artifact.

The sanitized command result includes the artifact digest and complete
`declarationJudge` value. Preserve the original skipped declaration as private
operator evidence, then use that returned value as the `judge` member of the
final `campaign.json` supplied to `npm run scorecard`. The scorecard independently
recomputes the artifact digest and rejects any mismatch.

## Reproduce and publish

Run first without write authorization:

```bash
npm run scorecard -- \
  --state-dir /operator/private/five-runs \
  --acceptance-dir /operator/private/acceptance-evidence \
  --campaign-dir /operator/private/scorecard-campaign
```

The command refuses a dirty generator checkout, derives the generator revision
from Git, reruns the dependency exception check, `npm run check`, `npm run
build`, and `git diff --check`, then validates and renders the scorecard in
memory. The dry run prints only the decision, tested revision, and publication
status. A valid observed no-go returns nonzero; malformed or unsafe evidence
fails before producing output.

The campaign's `evaluatedAt` timestamp is the authoritative evaluation clock.
Dependency-containment and skipped-gate review dates are evaluated against its
UTC date, never against the reviewer's current wall clock. A model profile's
review date is advisory and does not change the decision. This
allows a later reviewer to reproduce the historical decision from identical
bytes. The dependency package-state digest binds the policy, checker,
`package.json`, and `package-lock.json`; all fixed inputs and the clean generator
revision are re-read and revalidated before publication.

After reviewing the inputs and derived decision, explicitly authorize the
repository write:

```bash
npm run scorecard -- \
  --state-dir /operator/private/five-runs \
  --acceptance-dir /operator/private/acceptance-evidence \
  --campaign-dir /operator/private/scorecard-campaign \
  --allow-write
```

Publication exclusively creates, without overwrite:

```text
docs/evidence/mvp-stabilization-<revision-prefix>/scorecard.json
docs/evidence/mvp-stabilization-<revision-prefix>/scorecard.md
```

The publisher confines the new directory to the repository's existing
`docs/evidence` directory, pins and revalidates the publication root and parent,
rejects symlinked or swapped boundaries, and exclusively opens both files.
Directories are normalized to `0755`, files to `0644`, and a partial write is
rolled back without removing a substituted inode. Re-running cannot overwrite
prior evidence. Filesystem failures are reported without repository or host
paths.

## Classification and decision

Every record remains in the denominator. DocsFab reports eventual success,
first-attempt success, recovered runs, attempt-level incidents, terminal
failure classes, latency, token usage, retries, and scheduled backoff. Blank,
malformed, throttled, timeout, context, transient-provider, terminal-provider,
invalid-request, scanner-policy, context-policy, and unexplained failures remain
distinct.

The structural campaign allows a correctly governed local context stop because
it proves the provider boundary failed closed. The reliability score does not
count that stop as success. Any non-success among the five currently yields
`not ready`; the five observations are explicitly not presented as an
availability estimate, confidence bound, or shared-service SLO.

The decision is computed, never supplied:

- `not ready` when a campaign run fails, structural evidence fails, live #34
  acceptance is absent, the model profile is not current, dependency
  verification fails, or local verification fails;
- `ready with contained limitations` when every hard gate passes but unknown
  economics or an advisory judge limitation remains; or
- `ready for internal MVP dogfood` only when all internal MVP gates pass with
  no active internal limitation.

Shared-service work remains listed even when it does not lower an internal MVP
decision. The former `brace-expansion` exception is resolved: the policy pins
Pi 0.84.4 with `brace-expansion@5.0.9`, and the no-exception dependency check
rejects reintroduction of versions affected by `GHSA-mh99-v99m-4gvg`.
