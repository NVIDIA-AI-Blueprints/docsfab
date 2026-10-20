# Local-user GitLab delivery acceptance

The delivery acceptance harness proves the complete local-user publication
path without SCM credentials or network access. It creates a disposable source
repository, a real bare remote, a successful revision-bound write run, an exact
patch, an authorized isolated delivery worktree, and a deterministic fake
`glab` boundary. Git worktree creation, validation, commit-object creation,
create-only push, receipt persistence, reconciliation, and restart behavior all
use the production delivery implementation.

## Deterministic offline proof

Select two disjoint owner-private roots outside the source repository and bind
the proof to the exact DocsFab revision under test:

```bash
npm run acceptance:delivery -- \
  --state-dir /absolute/private/docsfab-delivery-state \
  --evidence-dir /absolute/private/docsfab-delivery-evidence \
  --tested-revision FULL_DOCSFAB_COMMIT
```

The harness verifies all of the following before writing the manifest:

- the source branch, HEAD, index, tracked files, ordinary untracked files, and
  the bounded ignored-state observation are identical before and after delivery;
- deterministic governed readiness and audit runs succeed before the
  authorized write record enters publication, and their record digests are
  bound into the acceptance manifest;
- the run-record digest, patch digest, validation evidence, deterministic
  commit, bare-remote branch, fake draft MR, and terminal receipt all bind to
  one immutable source revision;
- a second invocation reuses the exact commit, branch, MR, and receipt with one
  MR-create operation;
- dirty tracked state, stale revision, patch conflict, failed validation,
  missing confirmation, denied push, and protection drift fail closed while
  retaining the original patch and next-step guidance; and
- independent OS processes recover after interruption immediately following
  commit creation, push, and draft-MR creation without duplicating the MR.

The case contract is versioned in
`test/fixtures/runtime-evaluation/delivery/acceptance-cases.json`. The harness preserves successful,
expected-failure, restart, and unexpected-failure workspaces under the private
state root by default. This keeps the complete trace available for independent
inspection; cleanup is a separate operator decision outside the harness.

The owner-only manifest is the sharing boundary. It contains hashes, immutable
revisions, stable dispositions, the draft MR IID, and failure codes. It rejects
credentials, raw provider transcripts, prompts, repository content, output-root
paths, source paths, and artifact paths.

## Installed Linux delivery regression

The existing `runtime:live-agent:e2e` Linux job also runs
`npm run test:e2e:live-agent` against the freshly packed and installed CLI.
On Linux, the scripted workflow uses its built-in documentation validator and
default draft-delivery path. A strict fake GitLab API endpoint and SSH protocol
shim connect Git to a disposable local bare repository; Git worktree, commit,
push, receipt creation, and replay still use the installed production code.
The regression requires exactly one opened fake draft MR, an opened saved
receipt with the Linux BubbleWrap backend identity and passing isolation
boundary, and a second CLI publication that reuses the same MR without another
create request. The CLI run leaves the source checkout unchanged. The
write-enabled live-agent run applies its saved patch to the checkout by
design, so its check is that the checkout keeps the same HEAD and only that
applied edit after the live agent publishes the run. The tagged job retains a
content-free JSON summary under `packages/runtime/ci-results/2332/` and prints
the same machine-readable evidence in its job log; provider transcripts and
patch contents are not included in that artifact.

This is installed Linux backend qualification, not evidence of authentication
or publication to a real GitLab project. macOS runs the same installed workflow
in patch-only mode because it cannot establish Linux Bubblewrap behavior. The
separately gated live acceptance above remains necessary for real-project
acceptance.

### JSON and ignored-state boundary

Every JSON evidence leaf used to assemble the chain passes through DocsFab's
bounded UTF-8 JSON evidence parser. Duplicate object keys, unsafe numbers,
malformed or poisoned structures, and sparse arrays fail before chain assembly
or live preflight. Sanitized chain and acceptance manifests are canonical JSON;
live mode rejects an equivalent but noncanonical byte representation instead of
silently rebinding it.

Ignored state uses the fixed, digest-bound
`docsfab-delivery-ignored-state-policy` version 1. Git enumerates ignored leaves
with ignored directories collapsed, which prevents an ignored dependency cache
from defeating the source count and byte ceilings. A regular single-link file
owned by the operator with owner-only permissions is opened without following
links, verified stable before and after its bounded read, and contributes its
pathname, mode, metadata, and bytes to the aggregate source digest. Directories,
oversized files, aggregate-overflow files, non-owner-private files, and
unsupported entry types contribute pathname and stable metadata but receive one
of the policy's closed `content-not-observed` reason codes. Entry-count or Git
output overflow fails closed because pathname invariance could not be proven.

The manifest retains only the aggregate source digest, policy digest, counts,
disposition, and closed reason codes. It never retains an ignored pathname,
per-file digest, file bytes, or credential material. Thus creation, deletion,
pathname, mode, metadata, and bounded-file byte drift change the source digest;
content underneath a collapsed or otherwise unobserved entry is explicitly
reported as `policy-approved-not-observed` rather than claimed unchanged.

## Separately gated live proof

No live action is implied by the offline harness. First reconstruct the
content-free chain descriptor from the actual owner-private evidence leaves:

```bash
npm run acceptance:delivery -- \
  --assemble-chain \
  --tested-revision FULL_DOCSFAB_COMMIT \
  --readiness-record /absolute/private/readiness.json \
  --declaration /absolute/private/declaration.json \
  --analysis-record /absolute/private/audit.json \
  --authorization /absolute/private/authorization.json \
  --reviewer-policy /absolute/private/reviewer-policy.json \
  --write-record /absolute/private/application.json \
  --patch /absolute/private/application.patch \
  --chain-output /absolute/private/acceptance-chain.json
```

Assembly strictly loads the authentic WorkflowRunner records, finalized bounded
improvement declaration, signed authorization, trusted reviewer policy, write
record, and exact patch. It verifies their byte hashes, common repository and
revision, selected gap, approved outcome, path scope, authorization signature
and lifetime, application task, impact evidence, and patch binding. A
self-consistent caller-authored descriptor is not sufficient.

Then run a read-only live preflight with the exact approved destination. Live
mode reloads all seven private leaves and requires the supplied sanitized
descriptor to exactly match a fresh reconstruction:

```bash
DOCSFAB_DELIVERY_ACCEPTANCE_LIVE=true npm run acceptance:delivery -- \
  --live --preflight-only \
  --approve-action inspect-only \
  --approve-project-id PROJECT_ID \
  --approve-project-path GROUP/PROJECT \
  --repo /absolute/source --run-id RUN_ID \
  --state-dir /absolute/private/runs \
  --tested-revision FULL_DOCSFAB_COMMIT \
  --chain-manifest /absolute/private/acceptance-chain.json \
  --readiness-record /absolute/private/readiness.json \
  --declaration /absolute/private/declaration.json \
  --analysis-record /absolute/private/audit.json \
  --authorization /absolute/private/authorization.json \
  --reviewer-policy /absolute/private/reviewer-policy.json \
  --write-record /absolute/private/application.json \
  --patch /absolute/private/application.patch \
  --offline-manifest /absolute/private/offline-manifest.json
```

The descriptor, seven private evidence leaves, and offline manifest are required
for read-only preflight and execution. The owner-private chain descriptor binds
the exact readiness, audit, operator selection, maintainer authorization, write
run, changed paths, and patch. The offline
manifest must come from the exact DocsFab revision under test and supplies the
strict 11-case failure/restart matrix. Live mode decodes both with the same
closed manifest contract used by offline mode and rejects unknown fields or
broken cross-links before publication.

Opening the draft MR is a separate invocation. It requires the same environment
gate, `--approve-action open-draft-mr`, the exact project ID and path, and the
fresh `--confirm-plan-sha256` value plus private delivery and receipt roots.
The production publisher creates only a dedicated source branch and a draft MR;
it never merges. A private `--evidence-dir` is also required; the live command
persists a content-free manifest that binds the approved destination, run,
plan, patch, validation, commit, push, draft MR, terminal receipt, and unchanged
source-checkout hashes.

Live cleanup is not automatic and never removes patches, receipts, manifests,
or worktrees. It requires another environment gate,
`DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP=true`, plus `--live-cleanup`, the exact
host/project/MR/source/target identities, the approved `ssh` or `https` remote
transport in `--approve-remote-transport`, and
`--approve-action close-draft-mr-and-delete-source-branch`. Cleanup is limited
to a non-target `docsfab-run/` branch. Remote observation and deletion use the same
pinned, fail-closed Git adapter as publication, including configuration and
credential-helper checks plus an exact revision lease on deletion.

Do not place credentials in command arguments, repository files, fixtures, run
records, or manifests. `glab` and Git use the current operator's already
provisioned credentials only at their normal host boundaries.
