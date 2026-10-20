---
title: "Verify That Documentation Needs No Change in DocsFab"
description: "Bind current documentation and comparison evidence so an update job can establish a verified no-change result."
status: draft
content.type: how-to
---

Bind current documentation and comparison evidence so an update job can establish a verified no-change result.

## Reach a Verified No-Change Result

A no-change candidate needs evidence; request text alone never certifies it.
The planner proposes `no-change`, the host checks the candidate against one of
the following two evidence bases, and the fixed read-only path must then confirm it:

- Source coverage under a comparison: the host needs admitted
  current-documentation, public-contract, and changed-source evidence. With a
  base and head commit comparison (`--comparison-base`) of two distinct
  commits, the commit range supplies the changed sources. With a workspace
  comparison (`--comparison-workspace`), or a base that equals the revision,
  no commit range declares the change. The public-contract and changed-source
  roles then rest on the sources the operator or the model nominated. With
  equal revisions there are no changed sources to read. Unless a
  changed-source role is nominated, the host records that changed-source
  evidence does not apply.
- Otherwise, the kept-page basis qualifies. This covers an ordinary request
  with no comparison flags, and a `--comparison-workspace` run without that
  coverage. The plan writes no page and keeps at least one page unchanged with
  disposition `retain`. The host admits each kept page as current
  documentation along with the request. Pages the plan marks `out-of-scope`
  are outside the assessment. This is the usual result when a page already
  describes the behavior or the change is internal.

Source coverage takes precedence when a run has both. In either case, the
reader brief must hold no unresolved question. When the read-only path
confirms the candidate, the run succeeds with the editorial outcome
`verified-no-change`. It writes no patch and opens no merge request. It exits
0 unless `--release-gate` fails its `inconclusive` product disposition. A
write run delivers a draft merge request unless you pass `--patch-only` or
`--dry-run`; for a verified no-change, its `PUBLICATION` section reads
`Status: not needed` instead of reporting a failure.

The result names its basis. Every no-change without a comparison of two
distinct commits carries a basis code in its editorial and product
limitations, and the human `EDITORIAL` section names the basis, as the following table
shows.

| Basis | Limitation | Human `EDITORIAL` line |
| --- | --- | --- |
| Base and head commit comparison of two distinct commits | None | `Editorial outcome: verified-no-change` |
| Workspace comparison with nominated sources | `no-change-basis.nominated-coverage` | `Editorial outcome: verified-no-change (basis: nominated source coverage, no commit comparison)` |
| Base and head comparison whose base equals the revision, with nominated sources | `no-change-basis.nominated-coverage` | `Editorial outcome: verified-no-change (basis: nominated source coverage, no commit comparison)` |
| Kept pages | `no-change-basis.kept-pages` | `Editorial outcome: verified-no-change (basis: kept pages, no commit comparison)` |

DocsFab writes the basis code itself and replaces any copy a model returns,
so a model cannot add or remove one directly. A model can still steer which
basis applies through the sources it nominates, so the result names every
basis other than a comparison of two distinct commits. A no-change recorded
under a workspace or same-commit comparison before DocsFab wrote this code has
no code in its product limitations, but its editorial limitations and
`EDITORIAL` line still name nominated source coverage.

`NEXT` for a verified no-change starts with
`No documentation change needed; review the kept pages if you disagree:` and
the kept pages, or points to the saved evidence when the plan kept none. It
then names the basis and lists any other recorded limitation, such as
`quality-evaluation-not-applicable`. A basis code is never reported as a
capability or policy wall.

When technical verification or review answers `not-applicable` instead of
`accepted`, the independent assessments do not confirm the no-change, and the
run fails after every step succeeded. The run records the refusal as
`editorialFinalizationRejection`:
`editorial-finalization-decision-independent-rejection` at
`$.evidenceRefs[].producers[].assessment`, with class `model-content`. The
FAILURE section and NEXT name both. Every other refusal of the final decision
records its own closed code the same way.

Every page the plan kept unchanged is named, whether the run wrote a patch or
not. The `--json` result lists them in `keptUnchangedPages`, and the human
`PATCH` section adds a `Kept unchanged:` line, which `--quiet` and
`docsfab runs show` keep. A page the request named and the plan kept is never
silent in these runtime surfaces. Hosted surfaces, such as the merge-request
status note, do not list kept pages yet.

A request that names the page to check, such as "starting from the CLI page
(`docs/cli.md`)", binds that page as a target the plan must address. An update
plan addresses a named page by changing it, or by keeping it unchanged with
disposition `retain` and giving the reason. Naming a page does not oblige the
plan to write it. A plan that does neither, including one that marks the named
page `out-of-scope`, stops at planning with the code
`omitted-mandatory-obligation` in class `planning-refusal`. Its message names
the page.

The remaining non-patch plans also end with a terminal, coded record, as
the following list describes:

- When the planner judges the evidence insufficient, the run stops after
  planning with `needs-input` and product disposition `inconclusive`. Its
  limitation is the planner's own code, or `insufficient-evidence` when the
  planner names none.
- A plan that keeps a page the host cannot admit as current documentation,
  for example a path the revision does not hold, cannot use the kept-page
  basis. Selection stops with `no-change-unsupported` and asks for the missing
  evidence.

None of these stops writes a patch or leaves the run record `running`.
