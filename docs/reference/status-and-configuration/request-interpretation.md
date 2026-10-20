---
title: Request Interpretation in DocsFab
description: How DocsFab reads a documentation request once before the first workflow step, records its reading, and when that reading stops a run.
status: draft
---

Before the first step of a documentation run, DocsFab asks the bound model
once for its reading of the request: the operation, the target pages, the
sources, what to preserve or leave alone, and any choice only you can make.
DocsFab checks that reading against your own words and the repository, seals
it, and records it on the run. `docsfab runs show` prints it in an `INTENT`
section. For more information, refer to [DocsFab Status and Configuration
Reference](index.md).

First-pass binding takes the run's write targets from an admitted intent, as
described in [How First Pass Uses the Intent](#how-first-pass-uses-the-intent).
The interpretation can stop a run before its first step, as described in
[Stops](#stops).

## When the Interpretation Runs

The step runs once per run, after preflight and before first-pass binding, for
`create-documentation`, `update-documentation`, `restructure-documentation`,
and `review-documentation`. A read-only review is interpreted too.

Before the step calls the model, the run resolves the `--change` range, runs
preflight, verifies the installed quality pack and its bound style profile, and
checks each `--source` path. A tampered, stale, or unsafe quality pack stops the
run with its own code, such as `checksum-mismatch`, and no model call. Other
checks run after the step, such as first-pass binding, the review scope, and
the check that a merged merge request's text names the commits its diff was
pinned to.

The step runs before the run is queued, so its model call comes before the
run's `running` status. A harness that must cancel a run before any provider
call sets `PI_OFFLINE=1`.

The step records one of the following outcomes in
`requestIntent.admission.outcome` without calling the model.

| Outcome | Reason | When |
| --- | --- | --- |
| `not-applicable` | `workflow-without-operation` | The workflow declares no documentation operation, such as `readiness`, `ia-analysis`, `ia-plan`, or `release-documentation-readiness`. |
| `not-applicable` | `instruction-absent` | The run has no instruction, or the instruction is blank. |
| `continuation` | `knowledge-continuation` | The run resumes a durable knowledge stop. The original run was interpreted. |
| `continuation` | `operator-input-resume` | The run continues an InputAsk, from `docsfab do --continue` or the live agent. A run ID alone is not a continuation. |
| `offline` | `pi-offline` | `PI_OFFLINE` is `1`. Acceptance runs set it. Any other value, such as `0` or an empty value, interprets the request with the model. |

`offline` means the request was not interpreted. It is recorded and shown,
and it is not an admitted intent.

## How First Pass Uses the Intent

When the outcome is `admitted`, the run's write targets are exactly the intent's
targets with the `write` role, less any page an exclusion covers. It does not
read the request words for pages. Each page still meets the documentation
write rule a named page meets: a page the rule refuses, such as an agent
instruction file under a directory that `documentationRoots` adds, stops with
`proposal-scope-unsafe-target`. Your own words still narrow the intent, read
with the clause rules first pass uses for a request without one. A page the
request names only where it says not to change it, defers it, asks whether to
change it, or keeps it unchanged stops with
`proposal-scope-non-actionable-targets`, even when the interpretation listed
it. Examples are "Do not change docs/release-notes.md", "Update docs/a.md
later", and "Leave docs/a.md unchanged". This holds however the request writes
the path: with `./`, a `#fragment`, backticks, quotes, brackets, a Markdown
link, or full-width punctuation. Navigation and index targets are not write
targets here.

First pass also carries your admitted authority preference into its evidence
assessment. When verified documentation disagrees with one consistent
implementation value, the implementation preference or default lets the run
continue with a `docs-stale` notice. An explicit documentation preference selects
one consistent documentation value and records "documentation preference;
implementation differs." Both notices name the values, source paths, and lines,
retain the original contradiction, and reach the planner as evidence that still
needs verification. Supporting documentation citations need not assert a disputed
value; the notice retains their paths and lines. Unknown source roles, unverified
values, and conflicting implementation values remain unresolved. A genuine conflict between
implementation sources asks one question that names their values and sources.

For JavaScript and TypeScript, first pass also distinguishes ordinary prose
comments from implementation quotations within the same file. It parses the
complete verified file and requires one exact quotation covered by ordinary
comments, separated only by whitespace, within the cited lines. A header can supply the
documentation side while the function body supplies the implementation side.
Supporting citations without a disputed value use their entire verified excerpt
for the same check; an ordinary comment elsewhere in the file does not change
the supporting excerpt's role.
Runtime strings, ambiguous or mixed quotations, compiler directives, legal or
security metadata, and uncertain syntax do not qualify as ordinary comment
documentation. This classification does not transfer an earlier operator
choice to a newly identified obligation.

If an assessment cites only disagreeing documentation pages, first pass can
corroborate a fact from an implementation file that every page links to. Each
file must already have been read and its complete bytes verified against the
retained file hash. Scalar corroboration requires a shared code identity: an
explicitly named exported constant, or a documented command-line default tied
to the implementation's argument parser. An incidental literal or an unrelated
object key supplies no such binding. The parser must use one immutable argument
collection without injected flags or unverified calls that can alter its inputs.
Writes to the default binding outside that parser, including iteration and
destructuring, remain unresolved.
Default expressions and computed pattern keys that only read the binding do not
invalidate it. Assignments to the supporting built-ins invalidate corroboration.

For single-property JSON examples that differ only in the property name, every
visible serializer call in the verified file must use one consistent static
property. Its value must be a primitive or an immutable binding whose initializer
establishes a primitive value. Undefined, function, symbol, `__proto__` setter,
computed-key, spread, and unknown mutable forms remain unresolved. The notice
names the property and its supporting implementation lines, even when the
assessment cited another part of that fully verified file. The example payload
remains unverified. A locally defined or reassigned `JSON` does not qualify.
Corroboration also requires self-contained source: runtime imports, member
mutations, and calls outside the supported argument parsing, console output,
process exit, and serializer forms remain unresolved. They can change inherited
serialization behavior without changing the visible JSON object.

These checks retain the original assessment and supporting citations. Unknown
or conflicting implementation sources still ask their own question.

In the live agent, you can answer an eligible contradiction stop with an exact
offered source option. The successor retains the original request and saved
non-authoritative conversation context, including after reopening the session.
DocsFab verifies the source record, repository revision, obligation, and context
before it continues. Context retains the saved-record requirement for trimmed,
nonempty text; invalid context is rejected before a stop is saved. Adding scalar
values to the same source excerpt during
reassessment does not invalidate an option that selected what that excerpt
states. If a fresh assessment replaces the obligation's ID, the selected excerpt
remains attributed context only; every new obligation is evaluated independently.
The original excerpt must still be present in the same verified repository bytes.
Attached sources and other external bindings still require a new run.

When first pass gathers evidence, it also reads the sources the intent names,
together with the files you pass with `--source`, under one source budget,
`firstPass.maxSourceFiles`. The reading is model output, so no source it names
stops the run, and the following rules apply:

- A tracked file binds as a source.
- A tracked directory binds its tracked files, all of them or none. They bind
  when they fit in what the budget leaves after your `--source` files and the
  sources the reading names before the directory. A directory that does not
  fit binds none of its files.
- Any other source the reading names gets one notice, and first pass goes on
  with the evidence it can bind. First pass never reads a path the revision
  does not track, a path the source export excludes, or host state. A tracked
  file it does not bind as a source can still be among the files it ranks and
  reads.

A source that is one of the pages the run writes is that page, not a source.
When first pass reuses a committed knowledge snapshot, it reads no intent
source. A file you pass with `--source` that the revision does not track still
stops the run with `path-not-tracked`.

Each notice has the code `first-pass-reading-source-unbound`, the path, and
one of the reasons in the following table. The run record keeps the notice in
`evidenceWarnings`. The LIMITATIONS section of the run output and the
`limitOverflow` list of the `--json` result print it. A run without `--quiet`
also prints it as a status line when first pass decides it. The following
table lists the reasons.

The following table lists each reason and when it applies.

| Reason | When |
| --- | --- |
| `not-tracked` | The revision tracks no file at the path or under it, such as a file or directory you have not committed, or a path that does not exist. |
| `glob` | The path holds `*` or `?`, such as `src/*.ts`, and no tracked file or directory has that name. First pass binds a source only by its exact path. |
| `export-excluded` | The source export never holds the path, such as `.env` or a path under `node_modules/`. |
| `host-state` | The path is in `.docsfab/` or `.git/`, which first pass never reads. |
| `unsafe-path` | The tracked file's path is not in Unicode NFC form, or it holds a backslash or a drive prefix, so first pass cannot bind it. |
| `over-budget` | Binding the file, or every file of the directory, would put first pass over `firstPass.maxSourceFiles`. The notice names the limit, the source count it would reach, and the `DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES` override. Refer to [Operational Limits in DocsFab](operational-limits.md). |
| `files-left-out` | The directory's other files bound, but first pass left out its files in `.docsfab/` or `.git/` and its files with a path it cannot bind. The notice counts them. |

The intent's constraints become first-pass obligations at the passage of your
request they quote. An `evidence-only` or `operational-next-steps` constraint
needs repository support. A `stop-before-mutation` or `non-publication`
constraint binds the later steps instead. First pass records each constraint
whole: one longer, as written, than `firstPass.maxObligationConditionChars`
stops first pass before any model call with
`first-pass-max-obligation-condition-chars-bound`. Refer to
[Operational Limits in DocsFab](operational-limits.md). Under an intent,
your own words still add two obligations, because they only narrow the work:
"keep the result local; do not publish", and a request to preserve content.
The passages the intent marks to preserve do not bind first pass yet, and the
plan still reads the request as before.

An `update-documentation` run takes first pass when the intent admits two or
more pages. With one admitted page, the planner updates that page, as it does
for an update that names one page.

When first pass finds a knowledge snapshot already committed in the revision,
at `.docsfab/reference-model/knowledge-accepted-snapshot.json`, the admitted
pages decide whether that snapshot supports the request, not the request
words. A request such as "Bring docs/a.md and docs/b.md up to date" with both
pages admitted goes on, and so does a request that mentions an about page or
an audience. A candidate snapshot, one no owner has accepted, supports two or
more admitted pages. It supports one admitted page only when the request lists
the repository-observed statements to write and the snapshot supports each of
them. If support is missing, first pass gathers fresh repository evidence for
the admitted page in its exported workspace. The run records the superseded
snapshot digest in its status and `evidenceWarnings`. The original repository
file stays unchanged, and the delivered patch excludes the replacement
snapshot. With one admitted page, a conflict the snapshot classifies as blocking only other pages
is recorded as advisory, and the support check still applies. With two or
more admitted pages, any conflict stops the run with `conflict`.

A run with `--canon-snapshot` and the resume of a run that stopped on its
knowledge snapshot apply the same check to the snapshot you supply. A fresh
`--canon-snapshot` run uses its own admitted pages. A resume uses the pages the
stopped run admitted: DocsFab stores that admission with the stopped run and
verifies it again before the resume, and before `docsfab runs` shows the resume
command. An admitted intent that names no page to write selects none, and the
run goes on as for a request that names no page. Neither path reads the request
words when the run has an admitted intent. Without one, both still read them
to decide whether the snapshot supports the request. With one admitted page
on a candidate snapshot, either path still stops with `insufficient-evidence`
unless the request lists statements the snapshot supports.

Without an admitted intent, first pass binds the pages the request names, as
before. That holds for the `offline`, `not-applicable`, and `continuation`
outcomes, and for an `advisory` reading the run went on past, described in
[Advisories](#advisories): no admission granted that reading, so it binds no
page. A create that names no page stops with `ambiguous-targets` before any
first-pass model call and asks you to name the page. A create whose reading
names no page has already stopped at the interpretation, so it is asked once.
DocsFab never builds a page name from the words of the request. With
`--canon-snapshot`, first pass does not run, so a create that names no page
goes on and the planner chooses the new page, which plan admission keeps
inside [the write scope](#the-write-scope).

A recorded intent that does not verify against the run's instruction stops
with `proposal-scope-binding-mismatch` and binds nothing.

The step never runs for `docsfab do --route-only` or `docsfab do --dry-run`.
Each child run of `docsfab do --delegate` is interpreted once.

`restructure-documentation` and `create-documentation` without `--allow-write`
keep their existing refusal, and the step makes no model call first.
`update-documentation` without `--allow-write` is interpreted, then stops at
its write step with `write-grant-required` as before.

## Advisories

The reading is model output, so these findings do not stop a run, except for
a create that names no page, described below the table. DocsFab records the
finding as `advisory` in `requestIntent.admission.outcome`, with its code,
keeps the reading on the record, and the run goes on with the workflow you
started. The following table lists the advisory codes.

| Code | When | What the run does |
| --- | --- | --- |
| `request-intent-target-missing` | An update or a restructure names no page. | The workflow chooses the pages, and plan admission keeps them inside [the write scope](#the-write-scope). |
| `request-intent-operation-mismatch` | The request reads as another operation than the run's workflow, such as "Check whether the docs need updating" on a run of `update-documentation`. | The run keeps its workflow, and plan admission keeps its pages inside [the write scope](#the-write-scope). An update can still end in a verified no-change. |
| `request-intent-model-question` | The model asks a question only you can answer. | The question is recorded, and the run goes on without an answer; plan admission keeps its pages inside [the write scope](#the-write-scope). |

A create is the exception. A `create-documentation` run, including a
`docsfab do` request routed to it, whose reading names no page stops with
`request-intent-target-missing` and asks which page, because only you can name
a new page's path. It asks whatever operation the reading names.

An advisory never widens what a run may write, for the following reasons:

- Every write target a reading names is checked against the documentation
  roots before the run goes on, whatever operation the reading names, as
  described in [Stops](#stops). For example, "Review AGENTS.md and fix
  whatever is stale" read as a review that writes `AGENTS.md`, on a run of
  `update-documentation`, is refused with `request-intent-outside-write-scope`.
- An advisory reading binds no first-pass target. First pass binds the pages
  your words name, as it does without an intent, and checks each against the
  documentation write rule, as described in
  [How First Pass Uses the Intent](#how-first-pass-uses-the-intent).
- The run's plan keeps inside [the write scope](#the-write-scope), as every
  run's does.

Sources and preserved content that a reading names are not checked against
the write roots: they are read, never written.

## The Write Scope

Every documentation plan of a local run, for a create, an update, or a
restructure, writes only inside the run's documentation write roots, whatever
its interpretation outcome: an admitted, advisory, `offline`, or
`continuation` run, including a continuation from `docsfab do --continue` or
the live agent. The roots are the `.docsfab.json` `documentationRoots` that
are write roots, or `docs/` and `fern/` without them. Writes that no
documentation plan makes keep their own rules: the `bootstrap` and
`site-bootstrap` workflows, and the `.docsfab.json` that a first write run
proposes. A hosted run does not read `documentationRoots`; its host grant
confines its writes.

Before interpretation, CREATE and UPDATE refuse a decisive explicit destination
outside these roots with `request-intent-outside-write-scope`, exit 1. This
includes traversal and absolute destinations. The refusal names the safely
displayable original spelling, the roots, and how to correct the request.
The guidance names file roots as exact files and directory roots as locations
for a page, including when both kinds are configured.
`docs/x.md` and `./docs/x.md` reach normal interpretation; this check does not
select a target. A bare UPDATE filename can still require interpretation to
locate it. A tracked root file such as `README.md` can be checked before
interpretation when its basename is unique in the selected revision. An
ambiguous basename still reaches interpretation. Read-source mentions,
questions, and requests to leave a page
unchanged do not become write destinations.

Unsafe instruction-file spellings such as `./docs/AGENTS.md`,
`docs/x/../AGENTS.md`, and `docs/ＡGENTS.md` do not name `docs/AGENTS.md`.
They retain `proposal-scope-unsafe-target` before interpretation. Protected
destinations keep that refusal when another target is outside the roots.

The following rules define what a root grants:

- A directory root grants the Markdown and MDX pages under it that the
  documentation write rule admits.
- A root at which the revision tracks a regular file, such as `README.md` or
  `tests/bats/README.md`, is a file root. It grants exactly that file, in that
  letter case, and nothing beside or under it: not `README.md.bak`,
  `README.md/x.md`, or `readme.md`. The file does not need to sit in a
  documentation directory, but it must be a Markdown or MDX page. A source,
  CI, hidden, third-party, or agent instruction file stays refused even when
  `documentationRoots` lists it.

The pages a request names are the least its plan addresses, never all it may
write. The plan must address every named page, or the run stops with
`omitted-mandatory-obligation`. It may add pages inside the roots, for
example when the request also asks to correct any other page the change makes
out of date.

Plan admission checks every page the plan writes, before any write step. For
a restructure, that includes the navigation companions: the index pages
beside the pages the plan creates or moves. They keep their `docs/` and
`fern/` grant only where it lies inside the roots, and an index outside them
is labeled `navigation-companion-not-granted` and left unchanged. A
restructure plan can also write `fern/docs.yml` and `fern/docs.yaml` when
each file exists as a regular file in the run's base workspace and a root
covers it. The confined reader checks each supported path independently of
the site configuration used for reachability. Both existing Fern files
qualify, including beside Sphinx or Docusaurus configuration. An absent path
or link does not qualify, so a plan cannot create another navigation file.
MkDocs' `mkdocs.yml` and `mkdocs.yaml` sit at the repository root, which no
root covers, so no plan writes them. No other plan writes navigation, and no
plan writes any other file that is not a page.

Before it plans, the planner is told the roots, directory roots and exact file
roots, that it may write only Markdown or MDX pages inside them, and, for a
restructure, every navigation file it can write. For a page outside the roots,
the guidance asks the planner to name the page and its `documentationRoots`
remedy in the summary. That is guidance: plan
admission still checks every planned write.

A plan that writes anything else fails the run with a scope code, class
`planning-refusal`. The step's error names each refused path and why. The
following table lists the scope codes.

| Code | When | Next action |
| --- | --- | --- |
| `plan-outside-write-roots` | A planned page that a root could hold is outside the run's roots, such as `notes/guide.md` without a `notes` root, or a restructure writes an existing Fern navigation file while the roots leave `fern/` out. | Add the page, or its directory, to `documentationRoots` in `.docsfab.json`, commit the file, and start a new run. For the navigation file, add its directory, `fern`. Or ask only for pages inside the roots. |
| `plan-target-not-writable` | A planned file that no root admits: a file that is not a Markdown or MDX page, such as `docs/open-api/owners.yaml`, `fern/other.yml`, `mkdocs.yml`, or a Fern navigation file the repository does not have, or a source, CI, or third-party file such as `src/notes.md`. | Make that change by hand, or ask for the Markdown page that documents it. |
| `plan-target-not-named` | A planned instruction file or hidden path is inside the write scope but the operator's own request does not name it. | Name each intended file by its exact repository-relative path in the request, then start a new run. Existing root and protected-path rules still apply. |

Older run records name either refusal `advisory-plan-outside-write-roots`.

### First-Use Project Configuration

On an ordinary first write, DocsFab derives credential-free project setup from
the host and proposes `.docsfab.json` in the same reviewable patch. You do not
need to run a separate initialization command, commit configuration to the
default branch, or approve a second prompt.

A run that retains a local patch with `--patch-only` skips this setup when the
repository has no tracked `.docsfab.json`, unless the request names
`.docsfab.json`. It needs no GitLab remote, uses the default `docs/` and
`fern/` roots, and proposes no project configuration. A tracked `.docsfab.json`
stays authoritative and must be valid.

An explicit finite request for one or more pages narrows every path in the
proposal. The runtime binds the selected documentation workflow, instruction,
repository revision, and exact `docs/**` and `fern/**` targets before it creates
a file. You can repeat the same target in a later `change only` restriction.
The restriction must name the same target set as the output declaration.

If that scope does not name `.docsfab.json`, DocsFab keeps the derived setup in
host-private memory and omits the file from the patch. To include the project
configuration, name the exact `.docsfab.json` path in the same request. A model
or runtime-generated path cannot expand the caller's scope.

This behavior applies to the supported ordinary finite-path request form. When
an execution path requires a project configuration file outside that explicit
scope, DocsFab stops with a typed scope or input outcome before it writes the
file or starts the documentation writer.

## Stops

When the interpretation stops a run, DocsFab saves a record with no steps and
prints the run footer, or the `--json` run result, with one next action. It
never prints a knowledge-continuation command for these stops. The following
table lists the interpretation stops.

The following table lists each outcome, its code, the run status and exit, and the next action.

| Outcome | Code | Run status and exit | Next action |
| --- | --- | --- | --- |
| `question` | A repository question, such as `request-intent-target-absent` or `request-intent-target-present`, or `request-intent-target-missing` for a create that names no page, described in [Repository Admission](#repository-admission) | `needs-input`, exit 2 | Answer the question shown in `NEXT`. Every repository question recommends `stop`. |
| `refused` | `request-intent-internal-path`, `request-intent-disclosure`, `request-intent-outside-docs-root`, `request-intent-outside-write-scope`, or `request-intent-target-not-granted` | `failed`, exit 1 | `NEXT` names the refused path, the boundary it crossed, and the fix. A refusal is never a question. |
| `rejected` | The last rejection code, such as `request-intent-shape` | `failed`, exit 1 | Inspect the run with `docsfab runs show <run-id> --json`. Do not retry unchanged. |
| `unavailable` | `request-intent-model-unavailable` | `failed`, exit 1 | Check provider readiness with `docsfab doctor --live`, then start the run again. |
| `unavailable` | `request-intent-model-deadline` | `failed`, exit 1 | Retry once the provider responds. |

A `rejected` stop follows every re-ask: DocsFab re-asks the model with the
rule its reply broke up to `retry.maxRetries` times, so a run makes at most
1 + `retry.maxRetries` interpretation calls.

Cancelling a run during the interpretation takes the ordinary cancellation
path; it records no interpretation stop.

The following conditions refuse the run with a coded error instead of a stop
record:

- The prompt is larger than the bound model profile's input window:
  `request-intent-model-input-budget`.
- The tracked documentation tree is larger than the prompt inventory bounds,
  shown in [Limits](#limits).
- A host contract fault in the interpretation inputs.
- A fault in binding the configured model, such as a retired installed
  composition: the binding's own code, such as `composition-retired`, before
  any model call. Only a provider that fails once the model is bound is the
  `request-intent-model-unavailable` stop.
- A repository question longer than its bound, shown in
  [Repository Admission](#repository-admission).
- A `create-documentation` run whose `.docsfab.json` `documentationRoots`
  leave no documentation directory, because every entry is dropped or every
  one left is a file root: `documentation-roots-outside-write-roots`, before
  any model call.
- Any other run whose `documentationRoots` leave no documentation root, when
  the reading names a page to write: the same
  `documentation-roots-outside-write-roots`, after the model call and before
  any repository question. A reading that names no page, and a review, go on.

## The INTENT Section

`docsfab runs show <run-id>` prints an `INTENT` section after `RECORD` for a
run that reached the step. Records saved before the step existed have no
section. The section shows the following:

- the admission outcome and its code or reason;
- for an advisory, an `Advisory:` line that says what the run did instead;
- for an admitted intent, an advisory reading, or the intent a question was
  asked about (marked `Intent: not admitted`): the operation, each target as
  `path · role · chosenFrom`, sources, exclusions, constraints, and the
  authority preference;
- the question, its options, and the recommended answer, including a question
  the model asked that the run went on without;
- the refused path and the boundary it crossed, for an authority refusal: an
  internal segment, the update grant, the documentation roots, or the write
  scope, followed by the remediation;
- the number of model calls, their input and output tokens, and the number of
  page titles cut for the prompt.

Before it prints any field, `runs show` verifies the sealed intent against the
run's own `instruction`. A record that does not verify prints
`Admission: unverified (<fault code>)` and nothing else from the intent. The
seal is an unkeyed digest: it proves the intent is consistent with the
recorded instruction, not that nobody edited both.

The run record stores the field as `requestIntent`, with
`schemaVersion`, `admission` (`outcome`, `code`, `location`, `reason`,
`boundary`, `calls`, `clippedTitles`), and `intent`. Each entry in `calls`
holds the prompt and reply digests and token counts, never the prompt or reply
text. Those token counts are the only record of the interpretation's tokens:
the run's `usage` sums its workflow steps and does not include them, and the
`INTENT` section marks its token line `(not in the run's usage)`.

To count runs by how their interpretation ended, or the admitted readings by
operation and target source, query the run index fields `intentAdmission`,
`intentOperation`, and `intentTargetSource`, described in
[DocsFab Run Index Reference](query-failures-across-runs.md).

## What the Model Sees

The prompt holds the request-intent response contract rendered from
`config/model-output/contracts/request-intent.yaml`, the declared workflow and
operation, the documentation roots, the navigation set, the request verbatim,
and the tracked Markdown and MDX pages under the documentation roots, each with
its path and title. A page title is its frontmatter `title`, else its first
level-one heading. Navigation labels are not read yet and are shown as `null`.

## Repository Admission

After DocsFab decodes each reply, and before it admits it, it checks the
reading against the repository at the run's revision and against the run's
own grants. The request wording never widens any of these inputs.

**Declared operation.** The run's workflow declares the operation:
`create-documentation` is `create`, `update-documentation` is `update`,
`restructure-documentation` is `restructure`, and `review-documentation` is
`review`. For `docsfab do`, the routed workflow declares it. When the reading
names another operation, DocsFab records the advisory
`request-intent-operation-mismatch` and runs the declared workflow. It never
reroutes a run, and it asks no existence question for the operation the
reading names. For example, "Check whether the docs need updating" read as a
review on a run of `update-documentation` goes on as an update.

**Named pages.** An update or a restructure whose reading names no page
records the advisory `request-intent-target-missing`, and the workflow chooses
the pages. A create run whose reading names no page stops with the same code
and asks "The request names no page to create. Which page is meant?", with the
options `name-a-target` and `stop`; it recommends `stop`.

**Target existence.** For each write target, DocsFab asks the repository how
the path exists, with the same check plan admission uses for a planned page.
It asks again after every re-ask, because a re-asked reply can name other
targets. The following table shows the outcome for each repository answer and
operation.

The following table shows how each repository answer applies to each operation.

| Repository answer | Existence | `create` | `update`, `restructure`, or `review` |
| --- | --- | --- | --- |
| No entry at the path | `absent` | Admitted | `request-intent-target-absent` |
| The one exact-case tracked file | `file` | `request-intent-target-present` | Admitted |
| A file only under another letter case, a link, a submodule, or an excluded entry | `case-fold` | `request-intent-target-present` | `request-intent-target-case-ambiguous` |
| A directory | `directory` | `request-intent-target-present` | `request-intent-target-not-file` |
| A path under an existing file | `parent-file` | `request-intent-target-present` | `request-intent-target-not-file` |

A restructure may also move content into pages it creates. An absent write
target under a documentation root is admitted as a new destination page when
another write target of the reading is the one exact-case tracked file, the
page the content comes from. A restructure whose write targets are all absent
still asks `request-intent-target-absent`. A new page outside every
documentation root is refused with `request-intent-outside-write-scope`
first, because the restructure could never write it.

Each of these is a question with `stop` recommended, except a target outside
the run's update grant, which is refused with
`request-intent-target-not-granted`. Only a hosted run carries an update grant,
and a hosted run does not interpret its request, so a local run never meets
that refusal.

**Documentation roots.** DocsFab resolves the roots once per run, the same
way first-pass binding does: the `.docsfab.json` `documentationRoots` that
are write roots for a local run, such as `site/content`, or `docs/` and
`fern/` without them. A `review-documentation` run reads no configured roots
and uses `docs/` and `fern/`. The prompt lists the roots and the pages under
them. A create target outside every root is refused with
`request-intent-outside-docs-root`. A configured root at which the revision
tracks a regular file, such as `packages/<name>/README.md`, is a file root:
it covers that one page here, in first-pass binding, and in plan admission, as
[The Write Scope](#the-write-scope) describes. A directory named like a page,
such as `docs/api.md/`, stays a directory.

**Write scope.** The write scope is the documentation roots, for every
reading of every operation: a create, an update whose target the reading
chose from the inventory, and every restructure target alike, because the
run's plan writes only inside [the write scope](#the-write-scope). A review
run checks no write scope, whatever the reading names, because a review
writes nothing.

A target outside the scope is refused with
`request-intent-outside-write-scope`. For a Markdown or MDX page, `NEXT`
suggests adding the page, or its directory, to `documentationRoots` in
`.docsfab.json`; source, CI, and agent instruction files stay read-only. Without
`--allow-write`, the run gets the same scope; `update-documentation` still
stops with `write-grant-required` at its write step.

**Navigation.** Navigation is not read yet, so the navigation set is empty and
the prompt says so. A companion target, such as a navigation file to update
beside a new page, is corrected and re-asked. A reading that keeps one through
every re-ask is rejected with `request-intent-companion-not-navigation`. Each
re-ask is one more model call, recorded in `calls`.

**Question bounds.** A repository question names the path it is about, so a
long path can make it longer than the bounds the model's own question meets.
DocsFab refuses such a question with the bound's code, such as
`request-intent-max-question-chars-bound`, and never cuts it. The following
bounds apply:

- the question and its consequence, `requestIntent.maxQuestionChars`;
- each option, `requestIntent.maxOptionChars`;
- the number of options, `requestIntent.maxQuestionOptions`.

## Limits

The step adds these limits to `config/limits/requestIntent.yaml`. Run
`docsfab doctor --limits` to see their effective values. The following table
lists the limits.

| Limit | Default | Exceeded |
| --- | --- | --- |
| `requestIntent.maxPromptInventoryEntries` | 2,000 pages | The run is refused; the prompt never lists a subset. Raise it up to 20,000 pages with `DOCSFAB_REQUEST_INTENT_MAX_PROMPT_INVENTORY_ENTRIES`. |
| `requestIntent.maxInventoryPathChars` | 256 characters | The run is refused; a path is never cut. |
| `requestIntent.maxInventoryTitleChars` | 120 characters | The title is cut with an ellipsis and counted in `clippedTitles`. |
| `requestIntent.interpretationTimeoutMs` | 300000 ms | The run stops with `request-intent-model-deadline`. |

A larger page list must still fit the bound model profile's input window. A
prompt over the window refuses the run with `request-intent-model-input-budget`
before any model call.

The deadline covers every call of one interpretation. With an installed
composition, the effective deadline is the smaller of this limit and the
composition's `timeoutMs`.
