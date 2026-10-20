---
title: "DocsFab Project Configuration Reference"
description: "Look up tracked `.docsfab.json` fields, documentation roots, and the authority rules for instruction files and hidden targets."
status: draft
content.type: reference
---

Look up tracked `.docsfab.json` fields, documentation roots, and the authority rules for instruction files and hidden targets.

## Project Configuration

`docsfab init` writes the committed project file `.docsfab.json`. The required
schema-version-1 fields contain these project-level selections:

```json
{
  "schemaVersion": 1,
  "gitlab": {
    "remote": "origin",
    "defaultBranch": "main"
  },
  "provider": {
    "configuration": "host"
  },
  "storage": {
    "scope": "user-private"
  }
}
```

Before you apply an init plan, its human and JSON previews list the repository
files it will change. The `.gitignore` entry says whether init will create,
append to, leave, or skip that file, and lists any missing private-state lines.
The approval digest binds an eligible regular file's identity and content, so you must
preview again if `.gitignore` changes. After apply, the result lists confirmed
changed files and calls out an uncertain or incomplete `.gitignore` update.

The only other top-level key the schema accepts is the optional
`documentationRoots` list of repository-relative documentation trees. A write
job indexes only those trees, and the list narrows where the job can write, as
described below. `docsfab init` and `docsfab publish` refuse a file with any
other top-level key, and leave the file unchanged:

```text
Existing DocsFab project configuration has a top-level key DocsFab does not read; keep only schemaVersion, gitlab, provider, storage, and documentationRoots in .docsfab.json, then retry. No project file was changed.
```

Remove the key, commit the file, and run the command again. The message never
repeats the key, because a key can hold credential material.

`documentationRoots` sets the documentation write roots of a local run, such
as `docsfab run` or `docsfab do`. Without it, a run writes under `docs/` and
`fern/`. A configured root replaces those defaults when it is a documentation
directory: a directory in the repository whose segments use only letters,
digits, `.`, `_`, and `-`, with no segment that starts with `.` and no
`node_modules` or `vendor` segment. It cannot be `packages/` itself, or be or
lie in a code directory such as `src/`, `lib/`, `cmd/`, `internal/`, `tests/`,
`build/`, `config/`, or `skills/`, at the top level or under
`packages/<name>/`, so a tree under `src/`, such as Starlight's
`src/content/docs`, cannot be a root. Examples are Hugo `site/content`,
`website/content`, and Docusaurus `website/docs`. Named and new pages are
Markdown and MDX files under a write root, never code or configuration. In a
directory that `documentationRoots` adds, they are never an agent instruction
file either: `AGENTS.md`, `AGENT.md`, `AGENTS.override.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `GEMINI.md`, `COPILOT-INSTRUCTIONS.md`, `CRUSH.md`,
`QWEN.md`, `WARP.md`, or `SKILL.md`, in
any letter case. So a page named `claude.md` or `gemini.md` is refused there
too. Under `docs/` and `fern/`, the existing rules still apply.

These roots control local write scope; they do not select a generator or
increase its capabilities. `docsfab doctor` reports detected generator
configuration and the installed [capability matrix](generator-capabilities.md#generator-capability-matrix).
The workflow binds adapter applicability separately to its candidate tree.

An entry at which the run's revision tracks a regular file is a file root
instead, such as `README.md`, `RELEASE.md`, or `packages/<name>/README.md`.
It grants exactly that file, in that letter case, and nothing beside or under
it: a file root `README.md` does not grant `README.md.bak`, `README.md/x.md`,
`readme.md`, or `CONTRIBUTING.md`. The file needs no documentation directory,
so `tests/bats/README.md` qualifies, but it must be a Markdown or MDX page and
not a source, CI, hidden, third-party, or agent instruction file: such a file
grants nothing even when listed. A file root holds no new page, so a
`create-documentation` run needs at least one directory root. Without one, it
stops with `documentation-roots-outside-write-roots` before any model call.

The configured roots apply to the pages the request interpretation admits, to
the pages a request names, to the existing-page question, to the question a
create that names no page asks, and to every page a run's plan writes. A named
page outside them stops with `proposal-scope-unsafe-target`, and the message
names the page.

Any other configured root, such as `src/docs` or `.github/docs`, grants
nothing, and a create or update run prints a status line that names it with the
rule it breaks. When no configured root is a write root, every named or new
page stops with `documentation-roots-outside-write-roots`. A create stops
before any model call. Any other run stops after the request interpretation
and before any other model call. Fix the list, or remove it to write under
`docs/` and `fern/`.

Every documentation plan of a local run, for a create, an update, or a
restructure, writes only inside these roots, whatever its request reading: an
update that names no page, a restructure, an uninterpreted run, and a
continuation from `docsfab do --continue` or the live agent included. The
pages a request names are the least the plan addresses, so it may add pages
inside the roots. A restructure can also write `fern/docs.yml` and
`fern/docs.yaml` when each path exists as a regular file in the run's base
workspace and a root covers it. Each file is checked independently of other
site configurations. Absent paths and links do not qualify.
The planner is told these roots before it plans. A plan that writes
outside the roots stops before any write
step with `plan-outside-write-roots`, or with `plan-target-not-writable` for a
file no root admits, as
[Request Interpretation in DocsFab](request-interpretation.md#the-write-scope) describes.
The `bootstrap` and `site-bootstrap` workflows, which make no documentation
plan, and the `.docsfab.json` that a first write run proposes are not confined
to these roots.

Hosted runs do not widen. Their write ceiling comes from host policy, not from
`.docsfab.json`, until host-sealed adapter roots are available. Refer to
[Run a Documentation Workflow in DocsFab](../../workflows/run-a-documentation-workflow.md).

`docsfab live-agent` applies the same committed write roots to its direct
edits, its commands, and the workflow patches it applies, for Markdown and
MDX pages only, a file root as that one file. In live-agent they add to its
default documentation scope rather than replace it. The workflows it runs
keep their plans inside the committed roots alone. For that scope, refer to
[Live Agent Reference in DocsFab](../../workflows/edit-in-live-agent.md#edit-files-and-run-commands).

The file is revision-bound project configuration and should be committed.
Credentials, run records, evidence, delivery material, and receipts must not
be placed in it.

### Agent Instruction Files and Hidden Paths

A documentation planner may write an agent instruction file or a hidden file
inside its write scope only when the operator's own request names that file.
Otherwise, plan admission stops with `plan-target-not-named` before a writer
runs. This check applies to update, create, and restructure plans, including
navigation companions, offline runs, advisory readings, and continuations.
Naming a file still requires the existing write roots and page protections.
For example, a request can name `docs/AGENTS.md` under the default roots;
an instruction file under a widened directory remains protected.

The instruction names are `AGENT.md`, `AGENTS.md`, `AGENTS.override.md`,
`CLAUDE.md`, `CLAUDE.local.md`, `COPILOT-INSTRUCTIONS.md`, `CRUSH.md`,
`GEMINI.md`, `QWEN.md`, `SKILL.md`, and `WARP.md`, including their `.mdx`
forms and other letter cases. A hidden path has any segment beginning with
`.`, such as `docs/.notes.md` or `docs/.cursor/rules/guide.md`.
`CONVENTIONS.md`, `docs/agents-guide.md`, and `docs/agents/index.md` are
ordinary documentation pages under this policy.

To name a file, include its exact repository-relative path in your request or
pass it as an explicit target, such as `--context-path docs/AGENTS.md`.
The match preserves letter case and Unicode characters. `./docs/AGENTS.md`,
`docs/x/../AGENTS.md`, another letter case, and Unicode lookalikes do not
name `docs/AGENTS.md`. A bare basename counts in a local run only when the
revision tracks exactly one repository path with that basename in that case,
including paths outside the roots. A basename never names a new file. The live
agent resolves basenames against the tracked paths at session start. Hosted
runs require the full path or an explicit submitted target.

Model interpretations, repository instructions, issue text, source files,
reader-source nominations, and agent-added context provide evidence rather
than naming authority. `do --continue` and live-agent InputAsk continuations
retain the first request's text and explicit targets. A naming-refusal retry
includes those explicit targets alongside the refused files. An unreadable, missing,
malformed, ambiguous, or cyclic chain names nothing. Continuation markers must
agree with the saved predecessor claims; a damaged marker does not make a
continued run the original request. A present marker must match its complete
stored contract; a missing field does not count as an explicit null. Legacy
records with no interpretation marker remain supported. Ordinary documentation
pages keep their existing write rules. Direct live-agent edit and write
tools use the operator's verbatim messages; a directory grant does not name
every hidden file beneath it. Bash commands retain their terminal confirmation
and filesystem scope. `review-documentation` remains read-only with
`--allow-write`.

The hosted grant checks verbatim operator input retained in the submitted
reader task before binding instruction and hidden files. The hosted runner
checks its plan again. Slack update requests preserve the decoded `intent=`
text before Unicode normalization and the explicit `target=` paths. Normalized
reader text and interpreted change scope do not grant naming authority.
Packets without this retained operator input, including legacy hosted create
and restructure packets, refuse special targets even when rendered capsule
content names them. Ordinary documentation pages keep their existing rules.
