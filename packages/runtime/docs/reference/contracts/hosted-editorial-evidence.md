# Hosted editorial evidence

Schema-v2 `update-documentation` uses one canonical reader and editorial
evidence assembly in CLI and hosted execution. The hosted request carries a
closed `docsfab-reader-task-evidence` block with:

- validated `ReaderContextInputV1`;
- `inputOrigin` (`explicit` or `conservative-fallback`);
- optional NFC-normalized `requestText` for reader interpretation;
- optional `operatorInput`, containing verbatim `requestText` and explicit
  `targetPaths` captured by trusted operator ingress before normalization;
- an exact `base-head` comparison;
- canonical source-role and repository-relative path nominations; and
- `readerTaskSha256`, the canonical digest of the preceding fields.

The block is optional at the version-1 transport level so historical request
bytes and digests remain unchanged. The installed schema-v2 update workflow
requires it and refuses its absence before creating or invoking a model
harness. Its comparison head must equal the hosted request revision.

The Slack command parser captures `operatorInput` from decoded `intent=` and
validated `target=` values. The sealer includes those bytes in the digest and
checks their agreement with the normalized reader fields. A digest proves
transport identity, not operator provenance: callers must never reconstruct
this field from model output, normalized prose, repository text, or generated
reader context. The dispatcher grant and runtime plan admission use only this
field to decide whether the operator named an instruction file or hidden path.
Without it, no such exception is granted; ordinary documentation pages retain
their existing write rules. Legacy tasks omit the field without changing their
digest. The transport preserves both full text copies within capacity derived
from the existing Slack text ceiling.

## Canonical assembly

`assembleEditorialWorkflowEvidenceV1` observes the nominated tracked bytes at
the selected revision, projects the quality-pack reader task, builds the
content-index-bound context packet, and creates the durable
`WorkflowBranchEvidenceHost`. It returns `readerTaskContext`, `observation`,
`editorialEvidenceRefs`, and `workflowBranchEvidence`. The CLI delegates its
post-admission construction to the same lower-level
`assembleEditorialEvidenceFromAdmissionV1` function.

Every installed update step receives reader task context and editorial
evidence references. The planner must return a valid bound plan and editorial
candidate. Runtime selects only the frozen `author` or `assess-no-change`
suffix, validates every independent assessment, seals complete workflow branch
coverage, and adds candidate and final `editorial-decision` outputs to the run
record. Author execution uses the existing Git patch evidence collector so the
run record and final branch decision include the actual scoped write.

## Hosted policy and replay

The dispatcher policy's optional `readerEvidence` entry is bound into the
policy digest. It names `update-documentation`, allowed canonical source roles,
repository-relative path ceilings, and `maximumSourceNominations`. The
dispatcher checks the reader change scope and nominations against those bounds,
verifies each source is tracked in the selected checkout, and forwards the
unchanged sealed block. When that block is present, the runtime request also
carries the sealed installed reader-evidence policy and the terminal binds its
digest. Requests without reader-task evidence omit this field and preserve
their historical bytes.

Before model execution, runtime applies the installed policy to the complete
canonical admission closure: explicit nominations, change-scope documentation,
all changed paths from the base-to-head comparison, an admitted repository
instruction, and the virtual request instruction. It deduplicates by role and
path, then enforces the role, path, and count ceilings without filtering. The
virtual request instruction is exempt from the filesystem path ceiling but is
still role- and count-bound. A changed path whose exact head bytes cannot be
retained, including a deleted source, refuses the run before model execution.
The dispatcher receipt continues to bind the reader-task digest.

Decision payloads are first stored in the attempt-local `DurableArtifactStore`
under `stateDirectory/artifacts`. After installed execution returns, the
dispatcher immediately invokes the installed replay path without a credential
file descriptor. Replay treats the attempt store as read-only, verifies the
exact runtime-record digest, and supplies the `HostEditorialOutcomeAuthorityV1`
used to admit the terminal. The optional terminal editorial summary remains a
human-facing presentation and does not create authority. Omitting it or
reporting it as `unavailable` does not bypass replay or retention.

Before cleanup, the dispatcher copies the complete bounded artifact graph into
the project-bound content-addressed store. It retains a canonical manifest that
binds the reader-task digest, runtime-record digest, and repository revision to
each object's store digest, retained-object digest, size, and locator. The
dispatcher returns the manifest locator and digest with the retained result,
then removes the attempt store and workspace.

An authorized cold-replay consumer verifies the manifest bytes and digest
against independently trusted reader-task, runtime-record, and revision
bindings. It then verifies each listed object and reconstructs a new private
artifact store for installed replay. A locator alone, an altered manifest, or
missing object bytes cannot establish editorial authority. A proof or
diagnostic observer can still copy an attempt store before cleanup for
supplemental inspection, but durable replay does not require that observer.
