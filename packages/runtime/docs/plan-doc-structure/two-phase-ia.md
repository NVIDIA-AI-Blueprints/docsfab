# Two-phase information-architecture workflows

DocsFab separates information-architecture analysis from repository mutation.
Planning is read-only and produces revision-bound artifacts. Application is a
later invocation that accepts only an approved, unexpired successor plan for
the same repository state and exact output scope.

## Read-only site-creation cycle

For the fixed site/create journey, one command provisions the analysis input,
runs `ia-analysis`, provisions the planning input from that analysis run, and
runs `ia-plan`:

```bash
docsfab ia cycle \
  --repo /path/to/repository \
  --revision <full-commit> \
  --expires-at <future-canonical-UTC-timestamp> \
  --reviewer-policy /owner/private/reviewers.json \
  --reviewer-id maintainer:docs \
  --private-key /owner/private/maintainer-ed25519.pem
```

The command accepts no scope, mode, target, plan, application, or
`--allow-write` options: its task is always `ia-plan` / `site` / `create`.
It persists the ordinary package receipts and governed run records for the
analysis and planning stages. On a valid pending plan it terminates with
`needs-human-decision` and emits the exact existing `docsfab ia approve`
command for that planning run. The cycle never reads the supplied private key,
approves a plan, grants write authority, or applies a patch. The reviewer runs
the printed approval command separately; its approved receipt in turn emits
the existing `docsfab run site-bootstrap ... --allow-write` continuation.

Add `--json` for one schema-v1 cycle receipt, rather than a stream of the
intermediate receipts. The selected source checkout remains unchanged for the
entire cycle.

## Clean operator journey

Start from an exact clean Git revision. Input-package commands operate on a
tracked-only disposable export and write only to DocsFab's owner-private state;
the selected source checkout is never modified.

```bash
REVISION="$(git -C /path/to/repository rev-parse HEAD)"
EXPIRES_AT="$(node -e 'console.log(new Date(Date.now() + 7*24*60*60*1000).toISOString())')"

docsfab ia input provision analysis \
  --repo /path/to/repository \
  --revision "$REVISION" \
  --scope site \
  --mode create \
  --expires-at "$EXPIRES_AT"

docsfab ia input inspect analysis \
  --repo /path/to/repository --revision "$REVISION" \
  --scope site --mode create --input-digest <analysis-package-digest>

docsfab run ia-analysis \
  --repo /path/to/repository --revision "$REVISION" \
  --scope site --mode create --input-digest <analysis-package-digest>

# Use the exact analysis run ID printed above.
docsfab ia input provision planning \
  --repo /path/to/repository --revision "$REVISION" \
  --scope site --mode create --analysis-run <analysis-run-id>

docsfab ia input validate planning \
  --repo /path/to/repository --revision "$REVISION" \
  --scope site --mode create --input-digest <planning-package-digest>

docsfab run ia-plan \
  --repo /path/to/repository --revision "$REVISION" \
  --scope site --mode create --input-digest <planning-package-digest>

# Review the pending plan named by the planning run before signing it.
docsfab ia approve \
  --repo /path/to/repository --revision "$REVISION" \
  --scope site --mode create --run-id <planning-run-id> \
  --reviewer-policy /owner/private/reviewers.json \
  --reviewer-id maintainer:docs \
  --private-key /owner/private/maintainer-ed25519.pem

# Run only the exact Next command emitted by approval when mutation is intended.
docsfab run site-bootstrap \
  --repo /path/to/repository --revision "$REVISION" \
  --plan <emitted-site-bootstrap-application.json> \
  --reviewer-policy /owner/private/reviewers.json --allow-write
```

After one valid analysis output exists for the exact task and revision,
invoking `docsfab run ia-plan` before provisioning prints this planning
provision command as `Next`. The host derives it from that validated output,
quotes the durable source-checkout path and target as shell words, and never
emits a disposable workspace path or placeholder run ID. If zero or multiple
analysis outputs are valid, DocsFab remains `needs-input` without choosing one.

`create` is an alias for `provision`. Repeating unchanged provisioning returns
the same package identity and digest with `State: already-current`; it neither
rewrites the package nor touches sibling state. Each successful receipt binds
its `Next` command to that exact immutable digest with `--input-digest`; later
versions, changed expiries, and concurrent provisioning cannot redirect it.
When several valid versions exist, an unversioned read fails closed instead of
selecting by filename or expiry. Analysis provisioning creates
only DocsFab's fixed query-only navigation inputs. The validated analysis
handoff is then converted by host-owned deterministic evaluation, Template
Library, repository-check, and path-selection policies. The model cannot name
an input root, read a package path, select a host policy, approve its plan, or
grant write authorization.

Use `--json` on every `docsfab ia` command for the versioned machine-readable
receipt. Receipts expose the content-free repository identity, immutable
revision, content and index digests, package digest, expiry, disposition, and
one next command. `validate` exits nonzero unless the package is `ready`.
Diagnosis distinguishes `missing-package`, `invalid-package`, `stale-package`,
`wrong-repository`, `wrong-revision`, and `expired`. A planning result remains
`needs-approval` until `ia approve` creates a signed immutable successor.
Malformed JSON, digest tampering, output-bearing analysis input, symlinks,
non-owner files, permissive modes, oversize files, and package roots inside the
repository all fail closed.

## Fixed command surface

```text
docsfab ia cycle --repo <path> --revision <full-commit> \
  --expires-at <future-canonical-UTC-timestamp> \
  --reviewer-policy <owner-only-json> --reviewer-id <id> \
  --private-key <owner-only-pem> [--json]

docsfab run ia-plan --repo <path> --revision <full-commit> --scope site --mode create --input-digest <digest>
docsfab run ia-plan --repo <path> --revision <full-commit> --scope site --mode reevaluate --input-digest <digest>
docsfab run ia-plan --repo <path> --revision <full-commit> --scope section --target <path[#anchor]> --input-digest <digest>
docsfab run ia-plan --repo <path> --revision <full-commit> --scope page --target <path> --input-digest <digest>

docsfab run site-bootstrap \
  --repo <path> \
  --revision <full-commit> \
  --plan <site-bootstrap-application.json> \
  --reviewer-policy <owner-only-json> \
  --allow-write
```

The parser rejects unknown, repeated, and phase-confused options. `ia-plan`
never accepts `--allow-write`; `site-bootstrap` always requires it. A section
fragment identifies one heading-bounded Content IR node. A page target must not
contain a fragment.

## Planning phase

The host operation receives a closed task object rather than inferring scope,
mode, or target from prose. It runs after the normal repository scan and
context preflight against the disposable checkout. Its governed input contains
the exact Content Index plus:

- an evidence-backed ontology;
- materially distinct IA candidates;
- deterministic IA and navigation evaluations;
- use cases and policy bindings;
- either planned greenfield pages or complete migration dispositions.

Site creation produces planned pages. Site reevaluation assigns every current
document one of `keep`, `rename`, `move`, `split`, `merge`, `cross-link`,
`archive`, or `needs-human-decision`. Section and page planning are initially
reevaluation-only. A missing semantic input is `needs-input`; unresolved open
decisions or dispositions are `needs-human-decision`. Neither outcome writes
to the selected repository.

The ontology, candidate, IA-evaluation, navigation-evaluation, and pending plan
are canonical artifacts. They are persisted in an owner-only, atomic,
content-addressed store. Run records contain only their kind, schema version,
digest, repository revision, and repository content digest, so a later process
can recover the exact bytes without embedding repository content in the record.

## Review phase

A pending plan is not apply-eligible. The host review boundary matches an
Ed25519 private key to an explicit reviewer in a content-addressed reviewer
policy. The private key never enters a prompt, artifact, run record, or source
repository.

Review produces signed evidence and an immutable successor IA plan:

- `approved` records reviewer identity and time and creates an active plan;
- `changes-requested` records a bounded reason and requires a materially
  revised pending successor before approval;
- `rejected` is terminal for that proposal.

Reviewer role, repository identity, plan expiry, predecessor references,
supersession, open decisions, and unresolved migration dispositions are checked
again. Only the approved successor validates at the application boundary.
`--allow-write` is a separate capability and cannot change any approval state.

## Application phase

The `--plan` input is a sealed site-bootstrap application document. It binds
the approved successor plan to the exact IA evaluation inputs, topics, Template
Library catalog, repository-check policy, repository revision, content digest,
and index digest. The loader uses bounded, no-follow, stable regular-file reads.

Immediately before mutation DocsFab revalidates:

1. the application and plan digests;
2. signed host-authorized approval and expiry;
3. repository revision, content digest, and index digest;
4. deterministic IA and navigation evaluation;
5. template and repository-check policy identities;
6. create-only output scope, collisions, symlinks, and formats.

The authentic template-set bytes remain behind an opaque host capability.
Creation happens only in the disposable tracked export. Repository checks run
without a shell or inherited credential environment. Any partial operation is
bounded to transaction-owned files.

After mutation starts, every exit attempts deterministic impact postflight and
patch capture before writing the terminal record. Success requires the impact
paths and patch paths to match the approved outputs exactly. Interruption,
postflight failure, check failure, or unexpected changes produce a failed
terminal record while preserving any reviewable patch that can safely be
captured. The requester-selected source checkout remains unchanged.

## Universal workflow evidence

The generic workflow runner invokes context preflight before every fixed step.
For every attempted write in `update-documentation`, `bootstrap`, and fixed write operations,
it invokes the production impact-postflight service once before patch capture.
The persisted evidence contains only a deterministic analysis digest and
sorted changed paths, or a closed `no-change`/`failed` disposition. Read-only
`readiness`, `review-documentation`, and `ia-plan` runs do not invoke write postflight.

Progress events carry a monotonically increasing per-run sequence. Artifact
references are emitted in production order after their step record is saved;
this preserves a future API/SSE seam without implementing a hosted queue.
