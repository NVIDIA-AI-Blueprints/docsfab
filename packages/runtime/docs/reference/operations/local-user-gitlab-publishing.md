# Local-user GitLab publishing contract

First-use is one operator command. `docsfab do "…"` or
`docsfab run <workflow> --instruction "…"` writes the documentation
patch and opens one draft merge request. `--repo` defaults to this
checkout. `--remote` defaults to `origin`. The operator does not paste
`--confirm-plan-sha256`; the runtime binds the exact fresh plan digest
internally. An empty write is not published. Retry of the same request
reuses the draft merge request. A succeeded write that the publisher
cannot decode is `run-record-contract-gap`, not a corrupt record; retrying
that record will not help, and the patch remains the recovery artifact.

An absent saved record reports `saved-run-not-found`, an operator-input
refusal, including after explicit run deletion. Use `docsfab runs list` in
the same configuration context and retain any `--state-dir` selection.
Choose an existing run before retrying. Existing invalid records, private-file
refusals, and `run-record-contract-gap` keep their own diagnoses. An absent
record does not establish publication or cleanup authority.

The commands below are optional recovery for an already successful write
run. `docsfab publish <run-id>` is one-shot: the
host runs preflight, binds the exact plan digest, and opens the draft
merge request. `--preflight` prints the plan only. `--execute
--confirm-plan-sha256` is the two-phase review path after you inspect
that JSON. The run id is the durable handle: it is the run-record
filename stem and the patch filename stem. Resume does not re-run
planning, writing, or evaluation. Pass `--state-dir` when the record is
not in the default config-root runs directory. If `--state-dir` names the
parent of that run-store, or the config-root above it, preflight fails
closed with `state-directory-not-run-store`, names the selected
directory with its home-prefix redacted while preserving an actionable
suffix, and tells you to pass the run-store directory rather than its
parent. Pi does not receive Git, `glab`, SCM credentials, or this
operation's command output; the host publisher is the only GitLab
writer. Pass `--patch-only` on `do` or `run` to keep the original
private patch without opening a merge request. That patch remains the
recovery artifact if any later delivery step fails.

Sanitized first-use artifacts from a live `create-documentation` write
against an internal documentation repository (hydrate config, candidate knowledge snapshot,
publisher patch, and a succeeded publication result) are checked in under
an internal evidence record dated August 21, 2026.

A succeeded `--draft-mr` first-use prints one closed
`LocalUserGitLabPublicationResultV1` object and then
`Draft merge request: <url>`. Live example from 2026-08-21 (run
`f96f71e8-b423-46c7-8e02-3c756913e87c`, draft
merge request 527):

```json
{
  "commitRevision": "ce2d00a4768070ce87827829347c098fef4e2a23",
  "disposition": "succeeded",
  "idempotencyKey": "d84db372f13bf5e22037c17982e86791d40e0034999a1bf104d78b485a660fbd",
  "kind": "docsfab-local-user-gitlab-publication-result",
  "mergeRequest": {
    "draft": true,
    "headRevision": "ce2d00a4768070ce87827829347c098fef4e2a23",
    "iid": 527,
    "url": "https://gitlab.example.com/<group>/<project>/-/merge_requests/527"
  },
  "planSha256": "ed90020ffbc1cc5599264c127f46c61207f987cad7b32eef8abb091404984998",
  "receiptSha256": "a7f4ad0040dd2fa4232b5bc99779e8d49b0dc70d30f4779050580f7229102813",
  "schemaVersion": 1,
  "sourceBranch": "docsfab-run/f96f71e8-b423-46c7-8e02-3c756913e87c-79da99ef2fba-d635f6ca523fd48b",
  "state": "opened",
  "status": "opened",
  "targetBranch": "main"
}
```

Issue #38 implements the read-only planning phase and typed affirmative
authorization boundary. Issue #39 consumes that exact authorization to create
and validate a dedicated local delivery worktree. It still does not commit,
push, or open a merge request; those mutations belong to the downstream
publisher.

## Read-only preflight

One-shot `docsfab publish <run-id>` runs this
preflight internally. Use an explicit `--preflight` command only when
you want to inspect the plan JSON without opening a merge request:

```bash
npm run dev -- publish <run-id> --preflight
```

If more than one remote is configured, DocsFab selects `origin` when that
remote exists. Pass `--remote <name>` to choose another remote, including
on `docsfab do` and `docsfab run`. The target defaults to the GitLab
project's default branch; `--target-branch` selects another existing
branch. `--source-branch` can replace the deterministic
`docsfab-run/<run-id>-<revision>-<identity-digest>` proposal. The identity digest
binds the run ID, immutable revision, run-record digest, and patch digest.
Omitted `--validation-command` selects the versioned documentation-validation
profile. It does not infer `npm run check`.

Preflight runs only this read-only command family:

- Git repository, attached-HEAD, identity, remote URL, object, and
  remote-tracking-ref inspection (`not-a-git-repository`,
  `not-repository-root`, `head-revision-invalid`, `detached-head`,
  `missing-remote`, `ambiguous-remote` when several remotes exist and
  none is named `origin`);
- local Git configuration that enables hooks, fsmonitor, includes, or
  content filters (`unsafe-git-configuration`);
- the Git configuration that the publisher will read, which is the checkout's
  own with the operator's global and system files, read as `git config
  --includes --show-origin --null --list` under the publisher's Git
  environment, under the output bound `delivery.gitConfigurationListingMaxBytes`
  that the publisher also uses, and checked by the publisher's own policy
  (`git-config-policy.ts`): a refused setting is `git-configuration-refused`,
  naming the setting and its file, and a listing that cannot be read or is larger
  than the bound is `git-checkout-unverified`. This runs before the model, so a
  refusal costs no model call;
- a `--repo` path that is not the source checkout recorded by the
  succeeded run (`repository-mismatch` only);
- `glab version` (`glab-unavailable` when the binary is missing);
- hostname-scoped `glab auth status --hostname <host from the selected
  remote>` whose output is discarded
  (`gitlab-unauthenticated` for HTTP 401, no token, or not logged in on
  that host; `gitlab-unreachable` for connection reset, timeout, TLS, or
  `ECONNRESET`);
- allowlisted GitLab API reads for the current username, canonical project,
  target branch, and branch-protection rules, using
  `glab api --hostname <host from the selected remote>`.

Tracked and staged files in the operator checkout do not fail this
observation. Publication applies the patch in a dedicated delivery
worktree. `--draft-mr` freshness fast-forwards a clean target-branch
checkout onto GitLab HEAD; when the checkout has tracked dirt, DocsFab
fetches GitLab HEAD and writes from that revision without moving the
operator files. `tracked-source-dirty` remains only when Git cannot read
the index during that catch-up.

The `--preflight` command never invokes Git credential helpers, prints
environment variables, fetches, or performs an SCM write. Authentication
possession proves only that preflight can identify the local operator; it
does not authorize publication.

## Plan and authorization

A successful preflight prints one canonical, content-minimized JSON plan. The
plan names:

- delivery mode, GitLab project ID/host/path, and selected remote name/transport;
- content-minimized local Git and GitLab identity evidence, including a SHA-256
  binding over the normalized configured Git name and email;
- immutable base revision, target branch and protection state, and proposed
  non-protected source branch;
- patch digest/size/change count, validation command, draft-MR disposition, and
  patch-only fallback;
- closed preflight check dispositions and a digest over the exact plan.

The plan excludes remote URLs, repository and patch paths, the raw Git name/email,
command stderr, unselected API fields, credential material, environment values,
patch bytes, prompts, and model output.

The later mutating publisher must receive a
`LocalUserPublicationAuthorizationV1` made by
`authorizeLocalUserPublication`. That affirmative gate is valid only for the
exact reviewed plan digest and the closed `publish` command. It is also an
in-process capability: a deserialized or structurally identical object is not
authorization. A valid plan or the operator's existing GitLab permissions
alone is never authorization.

The authorization is process-local and time-bounded. Publication rechecks its
window, the plan-bound local Git identity digest, current GitLab username,
project, default branch, and source-branch protection before every external
mutation. Raw Git identity values remain outside the plan and receipt; the
commit itself records the configured identity.

## Execute phase

Write jobs open a draft merge request by default. One-shot publish and
`do` / `run` bind `--confirm-plan-sha256` internally from a fresh
preflight. The digest exists so execute cannot silently use a different
plan if remotes, HEAD, or protection changed between review and
mutation. Operators paste it only on the optional two-phase path.

After reviewing the preflight JSON, the operator may run the separate execute
phase with the exact plan digest and explicit owner-private roots:

```bash
docsfab publish <run-id> --execute \
  --confirm-plan-sha256 <reviewed-plan-sha256> \
  --delivery-root /absolute/private-delivery-root \
  --receipt-root /absolute/private-receipt-root
```

The first execute recomputes preflight and refuses a changed digest, then binds
that content-minimized plan beside the receipt before claiming `planned`. A
retry loads the exact digest-bound plan and receipt first, so a later target
advance, authentication outage, or policy change can be reconciled instead of
being hidden by a new preflight failure. Recovery selectors must still match
the durable plan. Every invocation issues a fresh ephemeral authorization,
regenerates and validates a delivery worktree, and rechecks current provider
policy before any new SCM mutation. It never exposes a generic refspec, merge,
approval, repository-setting, or cleanup operation.

Immediately before merge-request lookup and again before POST, while holding
the cross-process lease, the publisher rechecks the authenticated username,
exact project identity, effective Developer-or-higher access, target existence,
revision and protection, source/default/protection policy, configured Git
identity, exact local commit, and exact remote source head. Any drift yields a
sanitized failure and zero merge-request POSTs.

The remote create uses exactly one full commit-to-source refspec and Git's
explicit empty-expected lease, `--force-with-lease=refs/heads/<source>:`. The
option name is historical; this specific form is an atomic create-only CAS and
cannot update any existing ref. DocsFab prohibits `--force`, `-f`, `+` refspecs,
implicit or non-empty leases, tags, mirroring, pruning, push options, and target
branch writes. An exact existing source revision is reused before push. A lease
rejection is reobserved: an exact concurrent creation is reused and every other
revision conflicts. This boundary requires Git 2.9.5 or later and the
preflighted smart SSH or HTTPS GitLab transport.

Commit, push, and merge-request output is bounded and discarded. Only strict,
content-free evidence advances the owner-private append-only receipt journal.
The merge request is always draft, targets the preflight-approved branch, and
is either the exact marker-bound existing delivery or one newly opened request.
Generated titles use `Draft: [DocsFab Run] <bounded summary>` with the DocsFab
attribution exactly once. The body leads with fixed STAR reviewer sections
(`## Situation`, `## Task`, `## Action`, `## Result`) projected only from
validated run fields, sealed lineage evidence, and optional sanitized operator
instruction under the #243 disclosure rules. When the run record carries
`credential-like-content` findings, a published field only looks like a
credential, or a required check could not run, a `## Notes` section follows
`## Result`. It first lists each required check that could not run, then
names each finding's location and rule, never the text, as described in
[Screens That Flag Instead of Refusing](../../../../../docs/about/security.md#screens-that-flag-instead-of-refusing).
A finding whose file name could change the description, such as one with a
space, a backtick, or a line break, is counted instead of named.
Changed paths that contain a GitLab issue-closing statement are also counted
instead of named, so a filename cannot close an issue when the merge request
merges. The complete path list remains available in the local run record via
`docsfab runs show <run-id>`.
DocsFab's own configured credential, matched exactly, is never published. In
the workflow outcome, a changed path, the commit message, or the description,
it refuses publication. In the operator instruction, the description shows
`omitted (unsafe content or a configured credential)` in its place. The
Notes section leaves out a required-check line that holds it, or that holds
an issue reference such as `#` followed by a digit, and counts that line
instead. A machine
footer follows with a
visible `Published by DocsFab` section and one versioned, content-minimized
machine provenance marker. That marker contains only delivery, idempotency,
run, plan, source-revision, and patch identities; it does not embed
documentation content or credentials.

Epic #118 will extend publication metadata with validated task and input
projections. Those projections must come from the lineage and inputs
content-minimized projectors documented in
[Publication provenance projectors](../contracts/publication-provenance-projectors.md).
Commit/MR narrative rendering remains #129 and is out of scope for the
projector shim.

The non-idempotent merge-request POST is serialized by an owner-private,
cross-process receipt-root lease. The lease is held by a helper process across
the provider query/POST/confirmation boundary, releases when its caller exits,
and permits takeover only when the recorded publisher PID is no longer alive.
Killing the helper alone cannot make a live publisher's lease reclaimable;
nonce- and inode-bound cleanup releases that lease after the publisher action.
Each helper builds and syncs complete owner metadata in a unique private candidate
directory before publishing that directory as the canonical lock. A delayed
helper cannot initialize another generation's owner. Recovery stays bound to the
observed directory and owner file; it cannot move a newly active canonical lock.
Malformed owners and unrelated staging files remain refusals, and retry delays
are unchanged. Existing abandoned canonical locks retain their recovery rules.
If a helper is killed before publication, a private `.<key>.merge-request.lock.candidate-*`
directory can remain. That orphan grants no lease and does not block canonical
acquisition. Normal publication refusals remove the helper's own candidate;
automatic scavenging of crash orphans is deferred maintenance work.
After a crash, retry queries for the immutable project, source branch, target
branch, head revision, and exact provenance marker before deciding whether
another POST is needed. Maintainers may edit the human title and body prose
without defeating idempotent adoption, provided the marker remains exactly
once and unchanged. A missing, conflicting, or repeated marker fails closed.

The fake-adapter and local bare-remote suites are deterministic engineering
gates, not live-provider acceptance. Issue #42 owns the separately authorized,
gated GitLab test that opens one draft merge request in an approved project and
performs operator-controlled cleanup. Issue #40 remains open until that live
evidence is recorded.

The worktree readiness attestation remains process-local. A retry with a live
capability can reconcile a commit, remote branch, or merge request created
before receipt persistence. A new process verifies the retained capsule and
reissues a fresh capability only after proving its exact plan, patch, Git
registration, HEAD shape, index, and full filesystem. It then reruns validation
before reconciling the exact external state. A `committed`, `pushed`, or
terminal `opened` receipt is accepted only when the branch still equals the
receipt's exact commit SHA. Arbitrary branch drift is rejected.
A `planned` retry atomically creates the source ref if absent or reuses it only
when it still equals the immutable base, covering crashes on either side of
branch creation without adopting a changed branch.

Preparation authorization is checked immediately before creating private
delivery or receipt roots, repository lock state, plan/receipt journal entries,
Git index or tree objects, materialized files, validation scratch/processes,
and the prepared receipt CAS. Receipt helpers pause after pinning their exact
root or journal inode so the host can recheck authority before the first write.
Expiry blocks a new mutation but does not prevent separately governed rollback
or cleanup.

## Fail-closed checks

Preflight rejects an unsuccessful or non-write run, a missing/mismatched
patch, a source-path mismatch, a detached checkout, missing or ambiguous
remotes, ambiguous or project-mismatched fetch/push URLs, credentialed or
unsupported remotes, missing Git identity, unavailable, unauthenticated,
or unreachable `glab` for the selected remote host, project mismatch,
access below GitLab Developer, missing target branches, and revision
drift.

Offline `docsfab doctor --repo <checkout>` uses the same remote grammar as
publication preflight. The configured remote may be uncredentialed HTTPS
(`https://host/group/project.git`), scp-style SSH
(`git@host:group/project.git`), or URL-style SSH
(`ssh://git@host[:port]/group/project.git`). SSH requires the `git` transport
user; URL-style SSH permits a valid port. The URL must identify a GitLab host
and a group/project path. Credential-bearing URLs, explicit nondefault HTTPS
ports, query strings, fragments, and multiple remote URLs report
`gitlab-project-mismatch`. Inspect the remote named in `.docsfab.json`, correct
its URL, then rerun doctor. The diagnostic does not print the remote URL.

The run revision must exist locally and exactly equal GitLab's
target-branch commit. Publication preflight itself never fetches.
Updating refs is not an operator `git pull` tutorial: the `--draft-mr`
CLI prelude observes GitLab first and fast-forwards a clean checkout of
the target branch when HEAD is a strict ancestor of GitLab HEAD. A
pinned full commit SHA is never fast-forwarded. Publishing an already
stale run still fails closed, and the refusal carries its phase.
Pre-write there is no run to keep, so the operator diagnoses the
workspace and retries. Post-write the succeeded write is preserved and
republishes with `docsfab ship <run-id> --repo <path>`, which does not
re-run the workflow. A source branch may not equal the default or
target branch and may not match any GitLab protected-branch rule. Diagnostics contain only a closed code and remediation, so discarded
command output cannot leak into a record or terminal error.

A successful write is publication-eligible only when it has positive patch
bytes, positive patch lines, and at least one changed file. Zero-change runs
fail preflight before delivery-root or branch preparation.

## Isolated delivery worktree

The host-only `prepareDeliveryWorktree` operation accepts the reviewed plan,
its exact `LocalUserPublicationAuthorizationV1`, the private run-record path,
the selected source repository, and a separate owner-only delivery root. Before
creating anything it revalidates:

- the plan and authorization digests;
- the complete required schema-v2 run-record shape and relations, including
  terminal timing, token/tool arithmetic, model and skill aggregation,
  successful write evidence, and an effective scanner disposition of `passed`
  or valid `authorized`, plus the record digest, repository identity, immutable
  base, patch digest/size, and strict changed-file list;
- both configured remote URLs against the preflighted GitLab host/project and
  transport; and
- the complete source checkout filesystem, including tracked, untracked, and
  ignored bytes, modes, directory entries, and symlink targets, plus directly
  pinned HEAD, index, gitfile, registration, configuration, and shared-ref
  evidence. These state checks do not invoke working-tree-aware Git commands.

DocsFab copies the already verified patch bytes into a deterministic,
owner-only delivery capsule before invoking Git. Root, capsule, patch, and
worktree device/inode identities are revalidated around later operations. The
verified patch inode and digest remain recovery evidence, but Git never reopens
that pathname to apply it. DocsFab supplies the already-held verified bytes on
standard input at every apply boundary. Pathname substitution therefore cannot
turn a checked patch into a different applied patch. DocsFab then creates a new
branch and dedicated Git worktree with `--no-checkout` at the exact recorded
commit. Capsule and branch names include immutable identity digests, so
different runs remain isolated;
an identical concurrent delivery loses an atomic create race and cannot reuse
or overwrite the first delivery.

DocsFab loads the exact base into only the linked-worktree index, runs
`git apply --check --cached --binary`, applies the held binary-capable patch to
that index, writes the authorized tree, and compares object-to-object
rename/copy-aware `diff-tree` evidence with the record. It reads the authorized
tree as raw `ls-tree`/`cat-file` blobs and materializes those bytes with host
filesystem calls. Regular and executable modes and symlink targets are
preserved exactly; gitlinks and unsupported modes are rejected. No checkout,
reset, status, working-tree diff, text conversion, or filter-capable Git
materialization occurs. The review patch remains uncommitted.

Every Git invocation receives a credential-free environment, disabled global
and system configuration, prompting and pagers, a null hooks path, and disabled
fsmonitor. A strict operation allowlist admits only configuration/identity
inspection, no-checkout worktree registration, object/index patch operations,
raw object reads, exact forced worktree removal, and authorized branch deletion.
DocsFab rejects `core.worktree`, repository-local hooks, fsmonitor, filters,
external diffs, or diff-driver commands before any admitted operation. It
enumerates effective configuration with include origins, pins exact
bytes, modes, and identities for common config, source and delivery
`config.worktree` layers, and included files, and revalidates those pins around
each Git command. Branch cleanup accepts a changed config identity only when
the byte-level and effective delta is exactly removal of the authorized branch
section.

Configured validation is executed without a shell, with the delivery worktree
as its exact working directory, a private empty home/temp directory, offline npm
settings, disabled Git configuration and prompting, and a small environment
allowlist that excludes SCM/model credentials and agent sockets.

Isolation is a dual claim (investigation #265). Local-user
`interactive-once` publish (`local-glab`, operator at the keyboard) still
runs `--validation-command` (default `npm run check`) in the operator
environment. Isolation unavailable is not a publish blocker on that row:
Darwin and Brev-as-you are allowed, and `prepareDeliveryWorktree` may run
the validation command with an empty isolator prefix when confinement is
unavailable. macOS `sandbox-exec` is not a supported containment boundary;
it is simply not required for this row. Timed-out or output-bounded
commands kill their complete process group.

`standing-repo-grant` (host-owned org-bot apply) keeps the #110 isolation
bar. Host-owned standing-grant apply must not use the empty-prefix
fallback. Linux Bubblewrap with network and PID namespaces is the
supported containment boundary for that path: a behavioral probe must deny
loopback listen, not only outbound connect. When Bubblewrap is used, the
sandbox exposes only explicit system runtime paths, the validation
executable, the read-only delivery worktree, and private scratch roots. It
denies reads of the source repository and host credentials, all worktree
writes, all writes outside scratch, and all network access. The probe must
demonstrate denied reads of a real regular source file, the source HEAD,
and the canonical common Git config, denied worktree writes, allowed
scratch writes, and denied networking before validation. Linux candidates
are rejected when the source checkout or its Git directories overlap a
broad runtime mount such as `/usr`; otherwise that mount could expose the
source despite the probe. Failure of any of those standing-grant
boundaries makes preparation fail closed with
`validation-isolation-unavailable`.

Docker Desktop nested Bubblewrap is not a supported `--execute` host
(#259): preflight may pass, but nested `--unshare-net` that still permits
`listen(127.0.0.1)` fails the publisher probe and must stay fail-closed.
An internal agent sandbox image (`base-ubuntu2404-agent`) is likewise
preflight-only (#300): live `--execute` failed
`validation-isolation-unavailable` because `bwrap --unshare-net` could not
set loopback (`RTM_NEWADDR: Operation not permitted`) and user namespaces
could not write `uid_map`. Do not weaken the publisher probe for either
host.

DocsFab hashes the complete delivery filesystem before and after validation,
including tracked, untracked, and ignored bytes, modes, directory entries, and
symlink targets. It also directly binds HEAD, branch ref, index, gitfile,
registration, common-directory, and configuration evidence.
Validation failure or any delivery mutation preserves the capsule and returns a
governed failed capability for diagnosis. Command output is discarded rather
than added to an error, run record, or model context.

The source checkout is fingerprinted again on every exit path. Any filesystem,
branch, HEAD, index, or unrelated shared-ref change is a governed terminal
failure once the capsule exists. The only expected shared-repository transition
is creation of the exact proposed delivery branch at the exact base revision.
An owner-only cross-process repository lock serializes source fingerprinting,
branch/worktree creation, final invariant checking, and cleanup. The baseline is
captured at API entry before run artifacts or delivery paths are touched; even
an initial fingerprint failure returns a governed cleanable capsule once the
run and patch can be verified. The selected source checkout itself remains
identical. Linked-worktree `.git` gitfile bytes are included in delivery
fingerprints so redirection to another Git directory is detected.

`inspectReadyDeliveryWorktree` performs a fresh host-side state comparison and
returns an opaque-bound ready attestation containing the authorized tree,
exact preserved-patch digest/size, workspace key, and validation command/state
digests. Inspection, assertion, and published cleanup each revalidate the
patch inode, mode, size, and digest. The SCM publisher can
assert that exact in-process attestation instead of inferring readiness from
the public capability fields; copied objects are not authority.

Ready and cleanup authority is process-local. On replay, DocsFab reconstructs
fresh authority only after matching the exact run, plan, and patch, checking the
private capsule and Git registration, independently deriving the authorized
tree from the base and verified patch, and matching the retained index and full
filesystem to that tree. The retained branch or detached HEAD must also match
one of the exact supported states. A mismatch preserves the attempt and refuses
replay; serialized paths alone never authorize publication.

## Failure preservation and cleanup

Once the delivery capsule exists, patch conflict, path mismatch, application
failure, validation failure, and validation mutation preserve the verified
patch and worktree for inspection. Preparation never performs implicit cleanup,
commit, push, or merge-request creation.

Failed execution names any verified preserved worktree or worktrees and branch,
and prints a `docsfab runs delete` preview command with the state, delivery, and
receipt roots. The failed result line carries those values as
`preservedWorktree` or `preservedWorktrees`, `preservedBranch`, and
`cleanupPreviewCommand`. A retry reuses an existing exact plan-bound attempt
after full state verification and reruns validation in fresh scratch space. If
the attempt changed, DocsFab keeps it and refuses replay without creating
another worktree. Older runs that
already have multiple attempts retain all of them for inspection and explicit
cleanup.

The immediate run output and saved `docsfab runs show` human output include
current verified retained resources under `PUBLICATION`. The JSON run result
can include an outer `retainedDelivery` object. It is separate from
`publication`, which describes the saved merge-request lookup, and does not
change execution, product, or publication verdicts. Inspecting the retained
state does not rewrite the saved run.

The optional object has the following fields:

| Field | Meaning |
| --- | --- |
| `status` | `retained` when the reported state is verified; `inspection-required` when some state cannot be verified or safely displayed. |
| `worktrees` | Verified preserved worktree paths. |
| `branches` | Verified retained local branches. |
| `keptBranches` | Notices explaining which branches remain protected from deletion. |
| `cleanupPreviewCommand` | The deletion preview command, or `null` when no safe command can be offered. |
| `explanation` | The reason inspection is required, or `null` when none is needed. |

A safe preview preserves the actual state, delivery, and receipt root
selections, including verified custom roots. Copy the complete command rather
than rebuilding it from displayed paths. The command previews deletion; only
the confirmation returned by that preview can request removal. No confirmation
value or private receipt is included in `retainedDelivery`.

For `inspection-required`, inspect the original publication directories and
settings before requesting a new preview. Do not infer that a missing field,
an absent merge-request lookup, or an empty path list means there is no local
state. Unknown or unsafe state does not supply an invented executable command.

Confirmed run deletion removes each worktree whose HEAD, index, and files still
match its approved state. It then deletes the run's DocsFab-named branch only
while that branch points at the base revision or at the delivery commit that
the run's receipt records, and no other worktree has it checked out, is
rebasing it, or is bisecting it. A rebase of another branch with `--update-refs`
that will move this branch counts as rebasing it. The deletion is a
compare-and-delete of the local branch reference at that approved tip, so a
branch that moves after the preview survives. It does not touch a remote
branch, a merge request, or the branch's `branch.<name>` settings in the Git
configuration. The preview names every other run branch as kept.

`archiveDeliveryWorktree` is non-destructive. `cleanupDeliveryWorktree` accepts
one of two opaque, in-process cleanup authorizations; a structurally identical
plain object cannot authorize deletion:

- `published` requires the original publication authorization and the opaque,
  WeakMap-backed terminal capability issued by the SCM delivery-record service
  only after a freshly confirmed external observation. Durable or cloned JSON
  is never cleanup authority. Its protected evidence binds the idempotency key,
  record, plan, run, patch, repository/project/remote, branch, target, base,
  committed revision, pushed remote revision, and full opened draft GitLab MR.
  Cleanup additionally requires direct HEAD/ref equality, an index tree equal
  to the published commit tree, and exact raw-tree filesystem equality before
  forced removal of only the registered worktree.
- `operator-discard` requires the literal
  `discard-failed-or-uncommitted-delivery` confirmation, the reviewed plan
  digest, and a bounded operator reason. Whether to delete the delivery branch
  is captured as a separate affirmative choice in that authorization.

Discard authority captures the exact current worktree identity, branch ref,
HEAD gitfile/registration/index metadata, and filesystem snapshot, so later
drift makes it stale. Cleanup revalidates the
repository, delivery root, capsule, and worktree identities through Git
worktree removal. It then atomically moves the exact capsule to a uniquely
named, identity-bound tombstone and removes only that tombstone. Partial cleanup
progress is retained in the host capability, allowing an exact authorized retry
without reopening a removed worktree or deleting an unverified path. The
original private run patch remains the patch-only recovery artifact.

If `git worktree add` reports failure after creating a branch, registration, or
directory, the capability records those exact operation-created partials.
Explicit discard removes and rechecks them retry-safely; the capsule is not
deleted while its worktree registration or branch ref remains.

Hosted bot/service identities, permission intersection, credential brokering,
merge, approval, protected-target writes, and repository-setting changes remain
outside this local-user contract.

The deterministic offline and separately gated live end-to-end proof is
documented in [Local-user GitLab delivery acceptance](../../publish-a-patch/delivery-acceptance.md).
