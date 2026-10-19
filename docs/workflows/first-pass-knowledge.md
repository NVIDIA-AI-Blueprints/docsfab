---
title: "First-Pass Knowledge in DocsFab"
description: "Understand which evidence a create or update job gathers before planning and why an unresolved obligation can stop it."
status: draft
content.type: explanation
---

Understand which evidence a create or update job gathers before planning and why an unresolved obligation can stop it.

## Bind First-Pass Knowledge

Create jobs and updates with multiple named pages gather first-pass
candidate evidence before planning. A single-page named update starts with
the update planner. An update that names no page also starts with the update
planner, which chooses the existing pages to change. Every page a plan writes
stays inside the documentation write roots, and the pages a request names are
the least the plan addresses: it may add pages inside the roots, as
[Request Interpretation in DocsFab](../reference/status-and-configuration/request-interpretation.md#the-write-scope)
describes.

First pass lists the selected revision's tracked files. It reads the sources
a request names by path before anything else, whatever their extension and
wherever they sit, such as an implementation diff or a code file. It then
ranks the other text and source files by how well their paths match the
request and its obligations. When one of its evidence bounds ends reading with
an obligation unresolved, the run goes on with the evidence that first pass
gathered. A `first-pass-evidence-gaps` limitation names the bound and the
setting that raises it. When a source the request names is missing, empty, or
not UTF-8 text and an obligation stays unresolved, the run stops, and the stop
names that source. If a bound also ended reading, the stop is
`budget-exhausted` and names the bound and the setting that raises it. Refer to
[Operational Limits in DocsFab](../reference/status-and-configuration/operational-limits.md).

First-pass knowledge remains a candidate. A conflict that blocks the
selected documentation target, an unclassified conflict, an unresolved
claim, or missing support stops the job with `needs-input`. Resume the
retained original task after the knowledge owner supplies an attributed
candidate snapshot. That procedure is
[Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md).

For a repository-native installation-guide create, the original request still
completes only when every mandatory obligation is supported. When that
conjunction fails, DocsFab can retain a host-held labeled draft of independently
supported Markdown, a writer-continuable scaffold when you asked for one, and
focused questions. The original request remains `needs-input`. The draft is
not a complete installation guide, a supported procedure, or a publishable
page. The host-held draft is not original CREATE success. This first-pass
preflight does not continue the stopped request when you supply an answer.
When a create or update run already exists, resume it with
[Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md).

An ordinary English create that names no Markdown path is still an ordinary
documentation request. The write set is `docs/` and `fern/`, or the
documentation directories that `documentationRoots` in `.docsfab.json` lists,
such as `docs/user` or Hugo `site/content`. When the
[request interpretation](../reference/status-and-configuration/request-interpretation.md)
admits a new page inside that set, DocsFab binds that page. Without an
admitted intent, as when `PI_OFFLINE=1` or after an
[advisory reading](../reference/status-and-configuration/request-interpretation.md#advisories),
the request stops with `ambiguous-targets` before any first-pass model call
and asks you to name the page. With `--canon-snapshot`, first pass does not
run, so the request goes on and the planner chooses the new page, which plan
admission keeps inside the write set.
DocsFab never builds a page name from the words of the request. A missing
`.md` token is not `insufficient-evidence` by itself. When no configured root
is a write root, the request stops with `documentation-roots-outside-write-roots`
instead, as a request that names its pages does.

DocsFab never proposes a destination for an update, because an update changes
a page that already exists. An update that names no page starts with the
update planner. If first-pass support receives such an update, it stops with
`ambiguous-targets` before any first-pass model call, and the message names
the candidate pages under the write set. Run the request again with the page
path in it.

You can name one or more exact Markdown or MDX targets under the write roots,
such as `docs/get-started.md`. DocsFab binds the unchanged
instruction, repository revision, workflow, and sorted target set. It
separates named read dependencies from write targets.

A named page must be a Markdown or MDX file under the write roots: `docs/` and
`fern/`, or the documentation directories that `documentationRoots` in
`.docsfab.json` lists, such as Hugo `site/content` or Docusaurus
`website/docs`, or exactly a tracked file it lists, such as `README.md`. A
protected, source, or CI path is never a target. Under a
directory that `documentationRoots` adds, neither is a page in a hidden,
`node_modules`, `vendor`, or code directory such as `src/` or `tests/`, nor an
agent instruction file such as `AGENTS.md`, `CLAUDE.md`, or `SKILL.md`.
DocsFab cannot write any other page, such as `README.md` at the repository
root when `documentationRoots` does not list it. Request interpretation
returns `request-intent-outside-docs-root` if the model proposes that page.
First-pass binding returns `proposal-scope-unsafe-target` when it identifies
the page as a requested write target. A provider that cannot distinguish a
destination from source context can still ask you to name a target if the model
omits it. Name a page under the write roots. A source-only path mention does
not grant write scope. A first-pass refusal names the page and the rule:

```text
DocsFab cannot write site/content/docs/install.md: a named page must be a Markdown file under docs/ or fern/, the default documentation write roots. To write pages in another documentation directory, list it in documentationRoots in .docsfab.json.
```

When no `documentationRoots` entry is a write root, a request that names its
pages stops with `documentation-roots-outside-write-roots` instead: the same
refusal a path-less create gives, with the same message. Fix
`documentationRoots` in `.docsfab.json`, or remove it to write under `docs/`
and `fern/`.

A request can name the same page more than once. When every mention asks for a
change to the page, DocsFab binds the page once:

```text
Update docs/install.md to add the --verbose flag. In docs/install.md, also fix the broken link.
```

When a mention excludes the page, as "Do not change docs/install.md" does, the
run stops with `proposal-scope-duplicate-targets` before any first-pass or
workflow model call, and the message names the page. So does a mention that DocsFab cannot read as a
request to change the page, such as a question, a condition, or a label like
"Target file:". A mention asks for a change only when its clause does all of the following:

- names the page right after a verb such as "Update", "Add", or "Fix", in a
  lead-in such as "In docs/install.md,", or after "in" or "to" following
  that verb ("Fix the link in docs/install.md");
- holds no word that negates, excludes, keeps, restricts, removes, makes it
  conditional, or defers the change, such as "not", "except", "keep",
  "only", "if", or "later", even inside Markdown emphasis such as `_not_`;
- is not a question, and uses only ASCII characters.

A clause ends at a line break, or at a period, semicolon, question mark, or
exclamation mark that a space or the end of the request follows.

DocsFab does not yet read an exclusion of a page named once: "Update
docs/b.md, but not docs/a.md" binds both pages. Name only the pages to
change.

Source-aware candidate validation supports plain Markdown, Fern, and
bounded subsets of MkDocs, Docusaurus, and Sphinx. Unsupported
configuration, plugins, or remote inventories produce a named limitation
or fail closed. This support does not claim native site builds.

The five-configuration source-coverage matrix records which of those
configurations have deterministic fixture evidence versus installed
named-workflow qualification. Refer to
[Documentation Source Coverage in DocsFab](../resources/evaluation/source-coverage.md).
That page is an evidence and limitation record. It is not a quality
threshold, a release gate, or a second way to start a job.

For the first-pass gatherer, interview, and reconcile procedures, refer to
[Gather Product Knowledge](index.md#gather-product-knowledge).

<AccordionGroup>
  <Accordion
    title="Preserve the Original Task During Snapshot Import"
    id="preserve-the-original-task-during-snapshot-import"
  >
    When the selected workspace retains
    `.docsfab/reference-model/original-task.json`, an explicit snapshot import
    must continue the same create or update workflow and the same instruction
    digest. A different workflow, changed instruction, malformed binding, or
    symbolic link fails with `intent-mismatch`. Resume with
    [Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md). Do not treat
    snapshot resume as the editorial work-product loop.
  </Accordion>
</AccordionGroup>

## Repository-Wide Evidence, Bounded Changes

DocsFab treats the target checkout at the selected revision as the
evidence universe. The planner can inventory and retrieve information from
the whole repository, but it does not copy the whole repository into one
provider prompt. For a write job, the plan freezes a page set before
authoring. If the outcome requires an unplanned page, the job stops with a
typed scope or input result before it produces a patch.

A `create-documentation` plan can name a page that already exists. When
exactly one planned page exists as a tracked file at that exact path,
DocsFab updates that page instead of creating it, keeps the same write paths,
and reports `CREATE converted to UPDATE` on the page's `PATCH` row. When two
or more planned pages exist, the job stops with `needs-input` and asks which
page the request means.

When a job step searches the repository, the run record keeps the complete
search evidence, and the host derives findings, gap ledgers, and the release
work plan from that evidence. Every model step that uses the search, in any
job, receives a compact search brief instead. For each search target, the
brief carries the outcome, coverage, limitations, remaining work, and the
cited repository paths, with each path listed once. The
`searchBrief.totalMaxChars` operational limit bounds the whole brief section
of the prompt, framing included. If cited paths do not fit, the brief lists as
many as fit and counts the rest. The run record's evidence warnings, and the
`LIMITATIONS` section of the run summary, then report how many paths the model
did not see. An unlisted path does not change any finding.

The following source-grounded recipes intentionally affect several pages.

| Job | Example instruction | Expected changed-page shape |
| --- | --- | --- |
| `create-documentation` | “Create a three-page onboarding set for the approved feature: an overview, a setup procedure, and a troubleshooting page. Link the procedure from the overview.” | Three new Markdown or MDX pages, plus a navigation file only when the plan includes that route. |
| `update-documentation` | “Update the authentication change across the overview, setup procedure, and troubleshooting page. Keep existing routes and align each example with the approved API.” | Three existing pages with the same reader-facing change; unrelated pages remain unchanged. |
| `restructure-documentation` | “Split the current deployment guide into overview, procedure, and recovery pages. Preserve routes, anchors, and inbound links.” | A mapped three-page set, with any copied, renamed, or navigation paths represented in the before-and-after map. |
