# Bounded documentation improvement campaign

DocsFab can verify one end-to-end documentation improvement without committing
raw model output or modifying the selected source checkout. The campaign is a
human-gated use of the existing `review-documentation` and `update-documentation` workflows, followed by a
local evidence command:

```text
tracked evidence -> read-only audit -> maintainer approval -> disposable write
-> durable Git patch -> clean-export validation -> independent review
-> sanitized evidence
```

The evidence command does not call a model. Running the two governed workflows
is a separate, intentional operator action and uses the configured provider.

For a capped multi-unit stewardship ledger (distinct kind
`multi-unit-doc-improvement-campaign`, not an extension of this single-gap
procedure), see the [multi-unit dry-run operator procedure](multi-unit-doc-improvement.md),
the [multi-unit campaign decision record](../plan/multi-unit-doc-improvement-campaign.md),
and [contract stub](../reference/contracts/multi-unit-doc-improvement.md).

## Private campaign directory

Keep the campaign directory outside the repository with mode `0700`; every
input leaf must be an owner-only `0600` regular file. Symlinks, hard links,
permissive files, changed files, unknown JSON keys, duplicate JSON keys, and
oversized patches fail closed. The directory contains:

| Leaf | Private content |
| --- | --- |
| `declaration.json` | The selected gap, tracked evidence, success criterion, immutable revision, and exact input digests. |
| analysis record | The terminal schema-v2 record from a successful `review-documentation` run. |
| authorization | The maintainer's explicit approval after the audit, bound to the repository, revision, immutable gap evidence digest, success-criterion digest, audit-record digest, outcome digest, intended paths, and expiry. |
| application record | The terminal schema-v2 record from the later successful `update-documentation` run, including the exact content-bound authorization task. |
| patch | The exact patch named by the application record. |
| independent review | A later confirmation that the patch addresses the cited gap without unsupported additions. |

The declaration, authorization, independent-review, reviewer-policy, and digest
requirements are normative [campaign envelope contracts](../reference/contracts/bounded-doc-improvement.md).

## Run sequence

Pin the repository to the complete commit selected for the campaign. Record a
small gap with at least one tracked evidence blob and one concrete success
criterion. Run analysis without write authorization:

```bash
npm run dev -- run review-documentation \
  --repo /absolute/source/repository \
  --revision <full-commit> \
  --instruction "Analyze only the declared bounded documentation gap; do not modify files."
```

Review the terminal audit record and proposed outcome. A maintainer then
creates the exact authorization artifact. At this pre-write stage,
`declaration.json` must already bind the exact analysis and authorization
leaves; application, patch, and independent-review leaf identities may be
well-formed placeholders because those artifacts do not exist yet. The
declaration is regenerated with their exact identities during finalization.
Its repository, revision, gap evidence, and success criterion must not change.
Only after that approval, run the write-capable workflow:

```bash
npm run dev -- run update-documentation \
  --repo /absolute/source/repository \
  --revision <same-full-commit> \
  --doc-improvement-campaign /absolute/private/campaign \
  --reviewer-policy /absolute/private/trusted-reviewers.json \
  --allow-write
```

Before the disposable export can be mutated, this invocation reads the
owner-only declaration, analysis record, authorization, and host-trusted
reviewer policy; verifies their exact byte digests and Ed25519 signature; and
checks the grant time. The same authorization preflight also pins the source
checkout, requires a clean exact `HEAD`, and reads every declared gap blob at
that revision. Those source and blob facts are revalidated after authorization
and again around export and terminal verification. It passes a content-bound `bounded-doc-improvement` task
to the runner, including the exact approved proposal whose canonical digest is
covered by the signature. The task also carries the first sorted tracked
documentation gap-evidence path as its deterministic local-context target. A
campaign therefore needs at least one tracked Markdown, MDX, reStructuredText,
or AsciiDoc evidence path under the supported documentation locations. That path is
indirectly signed by the authorization's complete evidence-list digest, so the
documented command needs no caller-supplied `--context-path`. Arbitrary
`--instruction` prose and context overrides are rejected for this campaign.
The prompt names only that proposal and the signed path set, and the
filesystem write tools reject every other leaf. The terminal application
record must contain that exact task, including the campaign/repository/gap
identities, analysis record, approved proposal and outcome digest,
authorization artifact and statement digests, context source, and intended
paths.

Copy the resulting record and patch into the private campaign directory,
complete independent patch review, and finalize `declaration.json`. First run
the verifier without publication authority:

```bash
npm run doc-improvement -- \
  --repo /absolute/source/repository \
  --campaign-dir /absolute/private/campaign \
  --evidence-dir /absolute/private/sanitized-output \
  --reviewer-policy /absolute/private/trusted-reviewers.json \
  --npm-cache-capsule /absolute/private/sha256-<cache-content-sha256>
```

The dry run validates all inputs and prints the exact sanitized JSON and
Markdown projection without writing. After reviewing that projection, repeat
with `--allow-write` to publish
`bounded-doc-improvement.json` exclusively; an existing output is never
overwritten.

The npm cache capsule is an explicit campaign-dedicated input, separate from
the campaign and evidence roots. Its directory name is
`sha256-<contentSha256>` and it contains `docsfab-npm-cache.json` with exactly
schema version 1, kind `doc-improvement-npm-cache`, the campaign ID, and that
content digest. The digest covers the sorted relative directory/file topology,
file sizes, and file SHA-256 values, excluding the manifest. The capsule root
and descendants are owner-only and immutable (`0500` directories and `0400`
single-link regular files). Populate only the dependencies selected by the
campaign's committed lockfile; a shared mutable npm cache is not eligible.

## What the verifier proves

The campaign, trusted reviewer policy, and sanitized evidence directory must be
outside the source checkout; campaign and evidence roots must also be separate.
The verifier pins and revalidates the source and disposable-workspace identities,
captures a content-free metadata snapshot of the complete source tree outside
`.git`, and requires both Git state and that tree snapshot to remain unchanged
before and after validation and after publication. It checks every cited evidence blob at that
commit, validates complete model-profile and governed-skill provenance in both
records, and rejects a read-only review-documentation run with a patch or an
update-documentation run without a write step and durable patch. A run whose scanner disposition is `authorized`
is accepted only when DocsFab can reconstruct the exact #32 authorization from
the raw report, credential-rule overrides, revision, and run creation time and
obtain the recorded effective disposition. A loose or edited authorized status
is not evidence.

Changed and previous paths in the application record must exactly equal the
authorized set before the runner can record terminal success. After applying
the patch, the verifier independently captures
the actual changed paths and computes the patch SHA-256, byte length, and line
count. Those facts must exactly equal the application record and deterministic
impact postflight; claimed path or line-count substitutions fail. Any expansion
fails the campaign instead of being published as success.

The command copies and hashes the approved patch before its first asynchronous
operation. Git receives only fresh copies of those held bytes on standard
input; no child process is given a mutable patch pathname. A separate external
index applies the same bytes with `--cached` to bind the expected tree. That
Git directory lives in a separately pinned owner-only host root which is never
mounted into the validation sandbox. Each recapture verifies the immutable
anchor, copies it to a fresh host-only Git directory, and pins its config,
HEAD, index, and object store around the fixed-configuration Git calls. The
command then exports the exact commit to a fresh disposable workspace, runs
`git apply --check`, applies the held bytes, and requires the resulting tree to
equal the expected tree. It recaptures that tree both before validation and
after `npm run check` and `npm run build`, so a check that edits an approved
file or creates an additional non-ignored file cannot inherit the original
patch evidence.

Every source, export, and external-index Git command runs with a credential-free
environment: system/global configuration, askpass, prompts, replacement
objects, hooks, fsmonitor, external diff/textconv, filters, and pagers are
disabled or rejected. Repository-local include or executable configuration
fails before export. This prevents repository-controlled helpers from receiving
ambient SCM credentials.

Validation installs already-cached dependencies with
`npm ci --offline --ignore-scripts` and requires a behaviorally probed sandbox
that denies host reads, out-of-scope writes, and networking. A ready path also
requires a kernel PID namespace with parent-death teardown so a validation
command cannot preserve a detached or `setsid` descendant after returning.
The current ready implementation uses Linux `bwrap` with `--unshare-pid` and
`--die-with-parent`. Its tmpfs root creates mount-target ancestors before
binding the runtime, Node executable, workspace, scratch directory, npm cache,
and immutable npm configuration leaves. macOS process groups and `sandbox-exec`
do not provide that lifecycle guarantee, so the verifier fails closed there
instead of claiming a successful campaign. The content-addressed npm capsule
is mounted read-only and revalidated before and after execution. Npm receives two distinct pinned,
empty, read-only user/global configuration leaves plus a scratch log directory;
the cache path is never reused as writable scratch. A missing locked dependency
therefore fails offline instead of falling back to the host or network. The
executed Node/npm runtime must be a root-owned, non-group/world-writable system
installation, recursively sealed by content and metadata while DocsFab itself
runs unprivileged. Preflight also requires the current user to have no effective
write access, including access granted through POSIX ACLs. Every canonical
ancestor directory from the Node/npm runtime paths through the filesystem root
is identity-pinned under the same ownership and write-access rules. Same-user
installations such as nvm or asdf fail preflight,
as does running DocsFab as root, because hashing alone cannot prevent a process
with the runtime owner's authority from changing bytes during execution. The
cache content digest is included in sanitized verification evidence.
Evidence includes the closed `npm-ci` command identity as well as apply, check,
and build identities. Only closed command IDs, exit status, and output digests enter the summary;
command output and the clean workspace are discarded.

The sanitized artifact contains repository-relative paths, immutable and
content digests, workflow/run identities, skill hashes, model-profile status
and hash, approval identity and timing, patch metadata, validation evidence,
and the independent disposition. It excludes the success-criterion text,
model summaries, prompts, instructions, patch bytes, raw records, command
output, source paths, artifact paths, credentials, and full model output.
OpenAI project tokens, Slack tokens, Google API/OAuth tokens, and the shared
repository-scanner credential families are rejected before serialization.

Publication creates an owner-only evidence directory, pins its identity, and
rechecks its canonical location outside the source and campaign roots. The
exclusive-created success-leaf descriptor remains open from the first byte
through pathname revalidation and all post-publication source/output checks.
If any post-write check fails, DocsFab truncates and syncs that same descriptor
before attempting identity-checked removal, so an ancestor-path swap cannot
leave a valid-looking success artifact behind.

## Live-evidence boundary

This implementation supplies the verifier and reproducible local validation
path. It does not itself constitute the real #35 outcome. Closing the issue
still requires an approved repository and provider destination, an actual
read-only audit, a maintainer's post-analysis approval, the governed write,
and a genuinely independent review. Keep the issue open until that sanitized
campaign artifact is produced and reviewed.
