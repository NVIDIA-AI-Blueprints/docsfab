# DocsFab runtime

DocsFab runtime powers persistent documentation conversations and bounded
workflow runs. The live agent can answer repository questions, apply installed
skills, edit documentation with authorization, and invoke workflows when they
fit the task. A workflow run binds selected steps to governed skill and quality
inputs and produces an inspectable run record and optional patch.

```bash
docsfab live-agent --repo /absolute/path/to/target-repo
```

`--repo` must be a local Git repository path. Git URLs fail closed. The DocsFab
repository itself is a supported target. A local checkout may originate from
GitHub or another Git host; DocsFab works with the local files and does not
fetch the repository URL.

## Choose your route

Use the package installation reference for an installed CLI. Source-checkout
paths in the following table start at the DocsFab repository root.

| I want to... | Start here |
| --- | --- |
| Install or use the CLI | [Package installation reference](docs/get-started/installation-reference.md), or `docs/get-started/installation.md` in a source checkout |
| Work through a conversation | `docs/get-started/live-agent-quickstart.md` and `packages/runtime/src/live-agent/README.md` in a source checkout |
| Understand jobs and outcomes | `docsfab help`, or `docs/about/core-concepts/documentation-jobs.md` in a source checkout |
| Find implementation code | `packages/runtime/src/README.md` in a source checkout |
| Change or validate the runtime | `packages/runtime/CONTRIBUTING.md` in a source checkout |
| Integrate the hosted child | `packages/runtime/src/host-invoker/README.md` in a source checkout |

The package boundary is `knowledge → runtime ← quality`. Knowledge owns
accepted source context; quality owns portable policy, rubrics, and evidence.
Runtime owns job selection, execution, confinement, records, and delivery
coordination. Pi is the current model-session adapter, not the portable runtime
contract.

## Repository bootstrap

`docsfab run bootstrap --repo /absolute/path/to/repository --allow-write`
inspects tracked repository facts and prepares a guidance patch. Its single
`repo-bootstrap` step can change only `README.md` and `AGENTS.md` files in
existing repository scopes. It preserves useful nested guidance and cannot
edit application code, configuration, or arbitrary documentation paths.

The result binds the exact source revision. Its evidence cites tracked file
lines the model read before editing them, and the host copies their original
text into the result. A file with credential-shaped content cannot be read
for a citation, so a README or AGENTS file that holds one cannot support
no-change. It reports an actual guidance patch, evidenced no-change, or unresolved
questions without edits. No-change requires existing, nonempty README and
AGENTS guidance; execution success alone does not establish that result.
The private run record retains the admitted judgment and actual Git evidence.
The source repository remains unchanged until a separately authorized apply.

Hosted bootstrap uses the same domain checks through `runHostedWorkflow` and
requires a separate workflow write grant with exact README/AGENTS paths.
Existing V3 dispatcher write scopes and workflow configuration can express
that grant; a Slack command cannot widen it. Operators must explicitly install
the workflow and register its inherited, genuinely approved project canon
through the existing authority operation before enabling member commands.
No per-member canon copies, publication, deployment or merge grant is inferred.

Readiness, release-documentation-readiness, and the audit-documentation
template audit remain separately executable read-only workflows. Foundation, Foundation-to-patch, IA analysis, IA planning
and site bootstrap remain outside this bootstrap endpoint.

## Sessions, turns, and workflow runs

| Entry point | What happens | Lifetime |
| --- | --- | --- |
| `docsfab live-agent` | Chat, inspect the checkout, load skills, make authorized documentation edits, or invoke a matching workflow. | A persistent local conversation spanning many turns and optional workflow runs. |
| `docsfab run` / `docsfab do` | Select and execute one catalogued workflow. | One bounded run with its own record and outcome. |
| Hosted live-agent channel | The host dispatches `live-agent-turn` with a verified prior conversation window. | The session spans requests; each child executes one read-only turn and returns the next state for the host to retain. |

The one-job contract applies to an individual workflow invocation. A live-agent
conversation can use direct tools without starting a workflow. Local sessions
resume from private Pi transcripts; hosted sessions carry explicit bounded
state between disposable child invocations. In a source checkout,
`packages/runtime/src/live-agent/README.md` explains both paths.

When a documentation workflow checks a proposed change, DocsFab records the
source and classification of repository guidance before selecting commands.
Commit and hook-install steps are contribution actions and do not run as checks.
The exact `pre-commit run --all-files` form may run when its executable is
available inside the admitted read-only, offline check sandbox; hooks that
need to edit the repository cannot gain write access. Unsupported forms and
missing checker dependencies remain visible as not-run check evidence. A
missing checker leaves documentation content unassessed by that check.

## Workflow turn recovery

Pi workflow attempts default to the full admitted provider-turn envelope for
context compactions and consecutive output-truncated tool-batch recovery. Every
attempt still obeys its admitted tool, token and elapsed-time budgets. Rejected
tool batches consume provider turns and tokens while executing no tools. If a
truncated batch cannot be retried within those bounds, the failure continues to
name `tool-arguments-truncated`.

The runtime limits configuration can lower `governance.maxCompactions` with
`DOCSFAB_GOVERNANCE_MAX_COMPACTIONS` (including zero) and
`governance.maxConsecutiveLengthStoppedToolTurns` with
`DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS` (one disables reissue).
`governance.minRecentToolTurns` / `DOCSFAB_GOVERNANCE_MIN_RECENT_TOOL_TURNS`
separately preserves at least one recent complete tool group during compaction.
Its default is the inherited preservation policy; raising this minimum reduces
compaction freedom. Existing retry delays and limit warning thresholds remain
unchanged.

These settings resolve inside the runtime process, including an explicitly
supplied `PiHarnessOptions.limits` configuration. A hosted child runs with a
clean environment; setting these variables on its parent does not project them
into the child. Hosted lowering needs explicit host-to-worker configuration.

The allowance is not a throughput promise. Offline real-Pi tests qualify the
shipped turn/tool boundary, repeated compaction beyond the previous allowance,
and lowered settings. Model latency, context pressure, requested tool batches
and cumulative budgets can stop an attempt sooner. Planner-summary sizing is a
separate response/record-carrier constraint.

## Quick start

Requirements are Node.js 24.21.0 or later, Git, and a configured Pi-supported
model provider for live runs. The Node.js minimum changes only between DocsFab
releases.

Install the CLI from a DocsFab source checkout:

```bash
npm --prefix packages/runtime ci
npm install --global ./packages/runtime
```

See the [installation reference](docs/get-started/installation-reference.md)
for target repositories, local patches, and GitLab merge-request delivery.

```bash
# Start or resume a local conversation (attached terminal required).
docsfab live-agent --repo /absolute/path/to/target-repo

# Show the installed jobs and inspect one without calling a model.
docsfab list
docsfab plan review-documentation

# Exercise the packaged product without a model key.
docsfab test

# Run a read-only documentation review.
docsfab run review-documentation --repo /absolute/path/to/target-repo
```

To preview review delivery for a GitLab merge request whose reviewed head is
present in the checkout, select the source and destination explicitly:

```bash
docsfab run review-documentation --repo /absolute/path/to/target-repo \
  --change https://gitlab.example.com/team/project/-/merge_requests/17 \
  --review-delivery-target https://gitlab.example.com/team/project/-/merge_requests/17 \
  --review-delivery preview
```

The preview retains the original review and source bytes, then plans delivery
without posting to GitLab. The two URLs must name the same merge request and
reviewed head. `--review-target` continues to select repository page paths.
This fresh-run route does not yet support `--review-delivery publish`.

For a focused PR review, the read-only documentation check applies the existing
governed template audit to each admitted page when its template set is available.
The retained review coverage names mapped, unmapped, not-applicable, and unknown
pages, and ties template suggestions to the rules actually checked. A page with
no established template or selected rubric stays unknown; no correction is
inferred from that absence.

The local live agent resumes the most recent conversation for the selected
repository. Use `--new` for a new conversation. Documentation edits are enabled
by default. Use `--read-only` to disable documentation edits, workflow writes,
and host commands. Host commands require terminal approval. `--allow-write`
enables writes explicitly and remains a compatibility flag. The workflow CLI
has separate delivery defaults, described below.

For live `doctor`, `profile inspect`, and `run` commands, first run
`docsfab setup` in an attached terminal. If a target has not been initialized,
DocsFab reports `project-config-missing` and prints the corresponding
`docsfab init` command.

When tracked repository instructions require a check and this host cannot
prepare the isolated check backend, `docsfab doctor` reports the
`required-check-isolation-unavailable` limitation with a next action. A write
run prints the same named `PREFLIGHT` warning before its first model call. The
run can still produce a patch; its final check evidence records that validation
could not run. With a working backend, doctor and run admission add no warning.

## How a job is requested

### Select a job explicitly

`docsfab run <workflow>` selects a named catalog job. The create, update, and
restructure jobs require a concrete `--instruction`:

```bash
docsfab run update-documentation \
  --repo /absolute/path/to/target-repo \
  --instruction "Update the installation guide for the new setup command"
```

These three CLI jobs enable writes and default to delivery through one draft
merge request. `--allow-write` remains accepted but is not required for them.
Use `--patch-only` to retain a local patch without applying or publishing it.
Use `--dry-run` to preview selection and delivery without inspecting or
modifying the target. Default MR delivery requires an `origin` remote (or
`--remote <name>`), authenticated `glab`, and permission to push and create
an MR. Tracked local changes stay in place; delivery writes from GitLab's
target-branch revision.
An authorized local write can retain a patch from a local Git repository with
no remote or `.docsfab.json`. Without tracked project configuration, DocsFab
uses the default `docs/` and `fern/` documentation roots. Publishing or
explicitly proposing `.docsfab.json` still requires project setup through a
supported GitLab remote. A malformed tracked configuration still stops the run.
`--comment-mr` posts one review summary on an existing merge request and
creates no branch or MR. The local CLI fails closed unless a host
review-summary port is injected; host composition roots call
`createCommentExistingMrPort`.

### Assess Documentation Readiness

`readiness` assesses the selected repository as input to agent documentation
work. `release-documentation-readiness` assesses public release documentation
against the existing governed release rubric. Both are read-only and use the
installed `assess-documentation-readiness` skill:

```bash
docsfab run readiness --repo /absolute/path/to/target-repo --revision <commit>
docsfab run release-documentation-readiness --repo /absolute/path/to/target-repo --revision <commit>
```

Source readiness combines deterministic artifact/inventory observations with
explicit model judgments of source completeness and usability. The host checks
each judgment's run, revision, search, and context bindings. A judgment cites
the tracked file lines the model read, and the host copies their exact text
into the record, so no quote depends on the model reproducing it. A file with
credential-shaped content cannot be read for a citation.
Missing or unsupported evidence remains specific and visible; an observed
required artifact meets the presence criterion. A `ready` result is an
assessment of the declared scope, not permission to publish or release.
The CLI and Slack result show the readiness disposition separately from
execution status, including unresolved criteria. Slack identifies the retained
assessment record; unavailable evidence never implies readiness.

Release readiness requires a valid `.docsfab.json` tracked at that revision;
its declared default branch binds the assessment. Hosted execution uses an
immutable tracked workspace and the same inventory and outcome projectors as
the local runner. The run record retains findings, limitations, unknown human
decisions, and release work-unit contracts. Successful execution does not by
itself mean the documentation is ready. Neither workflow grants publication,
merge, repository writes, or a human approval.

A hosted project must install the workflow and its model composition in its
dispatcher policy before `/docsfab run readiness` or
`/docsfab run release-documentation-readiness` is available to its authorized
Slack callers. Catalog support alone does not activate an existing deployment.

### Describe the outcome

`docsfab do` accepts one natural-language outcome and admits it to at most one
catalog job. A fixed table runs first; the configured admission model can choose
one job when the table cannot. Admission chooses a workflow only. It does not
grant tools or publication authority.

```bash
docsfab do "Update the installation guide for the new setup command" \
  --repo /absolute/path/to/target-repo
```

When `do` admits `create-documentation`, `update-documentation`, or
`restructure-documentation`, it runs the write job and defaults to one draft
merge request. `--patch-only` and `--dry-run` opt out of that default. Requests
that try to grant writes or install a classifier stop at `needs-input`.
Ambiguous requests remain `needs-input` unless the admission model can choose
one catalog job. Use `--route-only` when you only want the deterministic
classification result. On a table miss it names the jobs the run would offer
the admission model.

`--patch-only` and `--draft-mr` narrow the admission model's choice to
`create-documentation`, `update-documentation`, and
`restructure-documentation`; when the model names none of them, `do` stops at
`needs-input`. A review the table picks runs as `update-documentation`, which
can end in a patch or a verified no-change.
`--allow-write` grants writes and does not change the route.

For the complete option and outcome contract, use `docsfab help`,
`docsfab run --help`, and, in a source checkout, the workflow outcome
reference at `docs/reference/contracts/workflow-outcomes.md`.

## What the runtime owns

Implementation paths in this section are relative to `packages/runtime/` in a
source checkout.

- Persistent local live-agent sessions, direct tools, skill loading, and bridges
  to workflow execution and delivery in `src/live-agent/`.
- The validated workflow catalog in [`workflows/`](workflows/).
- Isolated target workspaces, bounded tools, run records, and patch evidence.
- The application seam and `WorkflowRunner` in `src/workflow-execution/`
  that execute the selected workflow.
- The Pi harness and its model, tool, usage, and output boundaries in
  `src/harness/`.
- Host-authority contracts for credentials, write grants, and draft-MR
  delivery. These authorities are runtime concepts; they are distinct from the
  sibling `packages/host` product.
- The hosted child-side request and result boundary used by
  `packages/host`.

The runtime does not own interviews or accepted canon (`packages/knowledge`),
portable quality policy (`packages/quality`), skill source text
(`packages/skills`), or mailbox and review UX (`packages/host`).

## Hosted Invoker Boundary

`packages/runtime/src/host-invoker/` in a source checkout is the internal child-side
execution seam for the host dispatcher. It is not another CLI and does not
select a workflow. The host supplies a closed, digest-bound request for an
exact repository state, workflow, context packet, composition, tool policy,
and durable claim. Hosted requests are read-only by default. Without a matching
host-minted `writeAuthority`, and for review workflows, the invoker rejects a
catalog workflow containing a write step. With matching installed reader and
write policies, a documentation authoring request may execute only the exact
write steps and paths named by its sealed authority. The Linux process exposes
those grant-bound targets in the disposable workspace while keeping the source
repository, release, no-grant workspaces, reviews, and evidence replays
read-only. The finite path ceiling can include documentation directories and
the exact files `fern/docs.yml` and `fern/fern.config.json`; it cannot grant a
wider Fern tree.

Original-source authority retains every admitted regular tracked file, including
binary assets with literal internal spaces in their names. Member paths preserve
their exact identity: the authority compares, sorts, and digests them as exact
strings and never parses them as citations, URLs, globs, or shell words, so a
member path may use any character Git allows, such as `+`, `@`, `!`, `,`, `#`,
`%`, `'`, `=`, `~`, and non-ASCII letters, up to
`sources.authorityMemberPathMaxChars` (512) characters. It refuses controls,
invisible format characters, line or paragraph separators, backslashes, colons,
absolute paths, a leading `~` or `-`, empty, traversal, or edge-whitespace
segments, braces outside a whole `{name}` segment, paths not in Unicode NFC, and
credential-shaped paths. A refusal stops with `source-authority-path-refused`
and names the path and the rule. This member-path contract does not change
citation-location parsing, so a member path outside the locator grammar stays
uncitable.

The runtime rechecks source freshness and returns host-bound patch evidence.
The host verifies the canonical editorial evidence before cleanup and retains
its complete artifact graph in project-bound content-addressed storage for cold
replay. This path can therefore produce and retain a positive hosted patch. It
does not grant publication or by itself establish live-provider execution,
service activation, or a deployed production run.

For hosted conversations, that workflow is `live-agent-turn`. The conversation
outlives the child: the host supplies prior state and retains the returned
answer and next state for a later turn.

The child parses and verifies the request, separately reads an attempt-scoped
provider credential when required, rechecks the clean exact Git state, and
constructs `WorkflowRunner` directly. It emits closed progress and terminal
records whose evidence remains bound to the request. The surrounding host owns
process isolation, durable claims, content retention, cancellation, and
cleanup. In a source checkout, `packages/runtime/src/host-invoker/README.md`
explains the current contracts and verification evidence.

## Closed-job three pins

This package is the machine. Validated manifests under `workflows/` mint pin A;
the generated skill crate is pin B; and generated quality policy plus selected
bar IDs form pin C. The full invariant is recorded in the closed-job
three-pins decision.

1. A closed DocsFab job has three pins: A the named job, B the hashed skill
   bytes and tools, C the bar ids.
2. Runtime is the machine; validated `packages/runtime/workflows/` manifests mint pin A.
3. `packages/skills/` mints pin B; a skill never schedules another skill.
4. `packages/quality/` mints pin C; “quality pack” means the crate of hashed
   B+C, not the quality directory.

## Relationship to the skills catalog

At selection time, the workflow manifest's ordered skill IDs must resolve in
the exact generated skill crate. The quality-pack manifest binds the selected
quality lock to that exact skill lock. Disk presence alone never activates a
skill or creates a job.

Author skill and quality sources in the sibling packages. Treat
[`skill-crate/`](skill-crate/), [`quality/`](quality/), and
[`quality-pack/`](quality-pack/) as generated staging. Follow the mandatory
factory loop in `packages/runtime/CONTRIBUTING.md` in a source checkout when
their canonical inputs change.

## Repository layout

These paths are relative to `packages/runtime/` in a source checkout.

| Path | Purpose |
| --- | --- |
| [`workflows/`](workflows/) | Canonical validated definitions for runnable and hosted jobs |
| `src/` | Runtime source, grouped by task and execution path |
| [`docs/`](docs/) | Package product contracts and maintainer records |
| [`skill-crate/`](skill-crate/) | Generated Pin B bytes and integrity lock |
| [`quality/`](quality/) | Generated Pin C policy bytes and lock |
| [`quality-pack/`](quality-pack/) | Generated manifest binding Pins B and C |
| `test/` | Package tests and runtime fixtures |
| `deployment/` | Local and Brev dogfood seams |

## Developing

Install dependencies and run the CLI from this package:

```bash
npm ci
npm run dev -- list
npm run dev -- run review-documentation --repo /absolute/path/to/target-repo
```

From a source checkout, use the validation bar in
`packages/runtime/CONTRIBUTING.md`. A solo runtime
product-code change on a quiet host runs `npm run check`. Parallel work on a
shared host uses the documented changed-test and smoke split. Generated sources
have their own regeneration and pin checks; do not edit their staged output by
hand.

## Design references

Use these paths from a source checkout:

- Runtime source map: `packages/runtime/src/README.md`.
- Runtime architecture: `docs/about/architecture.md`.

## License

Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

The `docsfab` package source code is licensed under the Apache License 2.0
(`LICENSE`). The skills packaged under `skill-crate/` are dual-licensed: their
instructions and documentation are under the Creative Commons Attribution 4.0
International License (`LICENSE-CC-BY-4.0`), and their scripts are under the
Apache License 2.0. Both license files ship in the npm package.
