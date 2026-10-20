# Input asks

Part of the [run records](run-records.md) family split (record family: input
asks). Durable knowledge-continuation receipts for a stopped, resumable
`needs-input` run. See [run-records.md](run-records.md) for the schema overview
and [continuable input-stop resumption](run-records.md#review-response-admission).

## First-pass source choices

When first pass stops because repository sources disagree, the stopped run
records the verified sides and one choice question. A selected source option
continues from the original assessment retained on that run, even if a fresh
model pass would name or phrase the obligation differently. The host checks the
saved run and choice chain, current request and repository revision, and the
source bytes before applying the attributed choice. The replay record must also
match the host's private seal of the original saved run and assessment. If
another contradiction remains in that original assessment, the next stop asks
about that remaining point. A run recorded before assessment replay was
available uses the older
conservative reassessment path.

## Durable Knowledge Continuation

For a direct CLI `create-documentation` or `update-documentation` first-pass
stop, the runtime saves a normal schema-v2 run record with `status: "needs-input"`
before it disposes the tracked export. The stopped record carries a
`knowledgeContinuationReceipt` and the exact repository identity, immutable
revision, workflow, and task-lineage projection. It has no workflow steps,
model or skill evidence, tool calls, or usage because admission stopped before
execution. The record and its `NEXT` projection contain the run ID and recovery
shape, not the original instruction or its raw candidate content.

The receipt points to owner-private artifacts under the state root's sibling
artifact store. Those artifacts retain the exact candidate snapshot bytes, the
original-task binding bytes, the private task record, and serialized origin and
lineage artifacts. Each artifact has a digest and the receipt has a closed,
versioned digest over its bindings. Missing bytes, malformed JSON, unknown
fields, digest substitution, unsafe selectors, symbolic links, ownership drift,
or repository and workflow mismatches fail closed.

The private task record (`schemaVersion` 2) also keeps the stopped run's
admitted request reading in `continuationTargets`, or `null` when the run had
no admitted reading. The resume and the `docsfab runs` resume command take the
pages to write from that reading, not from the request words. Each read
verifies it again: a reading sealed for another instruction fails with
`digest-mismatch`, and a reading that is not an admission for the stopped
workflow fails with `binding-mismatch`. A version 2 record without the field
fails with `invalid-shape`. A version 1 record, written before the field
existed, still resumes and reads the request words as before.

`knowledgeResumeReceipt` remains the native receipt for an ordinary candidate
snapshot import. It is distinct from `knowledgeContinuationReceipt`, which
links a new child run to a stopped first-pass run. A resumed child also records
`knowledgeContinuationRecoveryAuthorization` for the fresh host recovery
challenge and `knowledgeContinuationSnapshotSha256` for the supplied snapshot.
The current authorization is separate evidence and does not alter the original
lineage issuance.

The continuation attempt journal is append-only and private. It uses an atomic
sequence claim keyed by the stopped run, and each immutable attempt records its
predecessor, child run ID, candidate snapshot digest, process birth identity,
phase, and child record digest. An active owner returns `busy`. A provably dead
owner in `prepared` can be abandoned and retried through the next sequence. A
dead owner after execution begins, unknown process identity, or unknown live
descendant returns `recovery-required` until mutation quiescence is established.
An attempt that completed its writer never claims a second writer. If delivery
is unsettled, continuation can call the existing publisher reconciliation only
with a fresh matching delivery grant and the exact retained delivery intent and
target. It reuses the existing publisher idempotency key, so the same key cannot
cause a second physical publication. When delivery settles, the continuation
returns that saved result for reuse. Missing or mismatched current delivery
authority or target returns `delivery-recovery-required`; unsafe effect
uncertainty returns a precise bounded recovery result. Neither can be projected
as `not-requested` or settled success. A patch-only result remains
publication-free and does not suggest a publish action. Continuation does not
widen the write or publication grants.

A local-user GitLab publication plan is a separate sanitized delivery record,
not an extension of the raw workflow record. It projects only the run ID and
record digest, GitLab project identity and allowlisted username, remote name/transport,
immutable revision, branch policy, patch digest/size/count, validation command,
draft disposition, closed checks, and patch-only fallback. It excludes the raw
record, patch and repository paths, remote URL, Git name/email, command output,
environment values, and credentials. See
[`local-user-gitlab-publishing.md`](../operations/local-user-gitlab-publishing.md).
